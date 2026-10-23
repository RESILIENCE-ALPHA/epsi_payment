import http from 'http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { prisma, Prisma, UserRole, UserStatus } from '@epsi-pay/database';
import { paymentApp } from '../server';
import { parseAmount } from '../validation';
import { toHistoryEntryView } from '../service';

const WALLET_A = '11111111-1111-4111-8111-111111111111';
const WALLET_B = '22222222-2222-4222-8222-222222222222';

describe('Service Payment — Endpoints, validation & sécurité', () => {
  let server: http.Server;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(paymentApp);
      server.listen(0, '::1', () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // Simule une session valide en base (lue par requireAuth du module auth)
  const authenticateAs = (status: UserStatus = UserStatus.ACTIVE) => {
    vi.spyOn(prisma.session, 'findUnique').mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      tokenHash: 'hash',
      ipAddress: null,
      userAgent: null,
      isValid: true,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      user: {
        id: 'user-1',
        email: 'alice@epsi.fr',
        name: 'Alice',
        role: UserRole.CLIENT,
        status,
        createdAt: new Date(),
      },
    } as any);
  };

  const validPayment = { senderWalletId: WALLET_A, receiverWalletId: WALLET_B, amount: '10.00' };

  describe('Authentification', () => {
    it.each([
      ['get', '/wallets'],
      ['get', `/wallets/${WALLET_A}`],
      ['post', '/payments'],
      ['get', `/payments/${WALLET_A}`],
    ])('%s %s doit exiger un jeton Bearer (401)', async (method, path) => {
      const response = await request(server)[method as 'get' | 'post'](path);

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHORIZED');
    });

    it('doit refuser un compte suspendu (403)', async () => {
      authenticateAs(UserStatus.SUSPENDED);

      const response = await request(server).get('/wallets').set('Authorization', 'Bearer token');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('ACCOUNT_SUSPENDED');
    });

    it('doit laisser payer un compte LOCKED par le brute force (sa session reste légitime)', async () => {
      authenticateAs(UserStatus.LOCKED);
      vi.spyOn(prisma.wallet, 'findMany').mockResolvedValueOnce([]);

      const response = await request(server).get('/wallets').set('Authorization', 'Bearer token');

      expect(response.status).toBe(200);
    });
  });

  describe('POST /payments — validation des entrées', () => {
    it('doit exiger un en-tête Idempotency-Key', async () => {
      authenticateAs();

      const response = await request(server).post('/payments').set('Authorization', 'Bearer token').send(validPayment);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it.each([
      [{ ...validPayment, amount: '-5' }, 'INVALID_AMOUNT'],
      [{ ...validPayment, amount: '0' }, 'INVALID_AMOUNT'],
      [{ ...validPayment, amount: '10.001' }, 'INVALID_AMOUNT'],
      [{ ...validPayment, amount: '1e3' }, 'INVALID_AMOUNT'],
      [{ ...validPayment, amount: '10000.01' }, 'AMOUNT_TOO_HIGH'],
      [{ ...validPayment, senderWalletId: 'pas-un-uuid' }, 'INVALID_INPUT'],
      [{ ...validPayment, receiverWalletId: WALLET_A }, 'SAME_WALLET'],
      [{ ...validPayment, currency: 'euro' }, 'INVALID_INPUT'],
      [{ senderWalletId: WALLET_A, amount: '10.00' }, 'INVALID_INPUT'],
      [{ ...validPayment, recipientEmail: 'bob@epsi.fr' }, 'INVALID_INPUT'],
      [{ senderWalletId: WALLET_A, recipientEmail: 'pas-un-email', amount: '10.00' }, 'INVALID_INPUT'],
    ])('doit refuser %j (%s)', async (body, code) => {
      authenticateAs();

      const response = await request(server)
        .post('/payments')
        .set('Authorization', 'Bearer token')
        .set('Idempotency-Key', 'test-key-0001')
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.error).toBe(code);
    });

    it('doit renvoyer 400 sur un JSON malformé', async () => {
      const response = await request(server)
        .post('/payments')
        .set('Content-Type', 'application/json')
        .send('{"amount":');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('INVALID_JSON');
    });

    it('doit refuser un paiement depuis une IP bloquée (403) et l\'auditer', async () => {
      authenticateAs();
      vi.spyOn(prisma.transaction, 'findUnique').mockResolvedValueOnce(null);
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce({ id: 'b1', reason: 'ML' } as any);
      const auditSpy = vi.spyOn(prisma.auditLog, 'create').mockResolvedValueOnce({} as any);
      const txSpy = vi.spyOn(prisma, '$transaction');

      const response = await request(server)
        .post('/payments')
        .set('Authorization', 'Bearer token')
        .set('Idempotency-Key', 'test-key-0002')
        .set('X-Forwarded-For', '203.0.113.66')
        .send(validPayment);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('IP_BLOCKED');
      expect(txSpy).not.toHaveBeenCalled();
      expect(auditSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'PAYMENT_REJECTED', ipAddress: '203.0.113.66' }),
      });
    });
  });

  describe('POST /payments — destinataire par e-mail', () => {
    it('doit répondre 404 RECEIVER_NOT_FOUND pour un e-mail sans portefeuille compatible, et auditer le rejet', async () => {
      authenticateAs();
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.wallet, 'findUnique').mockResolvedValueOnce({ id: WALLET_A, userId: 'user-1', currency: 'EUR' } as any);
      const findRecipient = vi.spyOn(prisma.wallet, 'findFirst').mockResolvedValueOnce(null);
      const auditSpy = vi.spyOn(prisma.auditLog, 'create').mockResolvedValueOnce({} as any);
      const txSpy = vi.spyOn(prisma, '$transaction');

      const response = await request(server)
        .post('/payments')
        .set('Authorization', 'Bearer token')
        .set('Idempotency-Key', 'test-key-0003')
        .send({ senderWalletId: WALLET_A, recipientEmail: ' Bob@EPSI.fr ', amount: '10.00' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('RECEIVER_NOT_FOUND');
      expect(txSpy).not.toHaveBeenCalled();
      // E-mail normalisé, même devise, jamais le portefeuille émetteur lui-même
      expect(findRecipient).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user: { email: 'bob@epsi.fr' }, currency: 'EUR', id: { not: WALLET_A } }),
        }),
      );
      expect(auditSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'PAYMENT_REJECTED',
          details: expect.objectContaining({ reason: 'RECEIVER_NOT_FOUND', recipientEmail: 'bob@epsi.fr' }),
        }),
      });
    });

    it('ne doit pas résoudre le destinataire depuis une IP bloquée (pas de sondage des comptes)', async () => {
      authenticateAs();
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce({ id: 'b1', reason: 'ML' } as any);
      vi.spyOn(prisma.auditLog, 'create').mockResolvedValueOnce({} as any);
      const findRecipient = vi.spyOn(prisma.wallet, 'findFirst');

      const response = await request(server)
        .post('/payments')
        .set('Authorization', 'Bearer token')
        .set('Idempotency-Key', 'test-key-0004')
        .send({ senderWalletId: WALLET_A, recipientEmail: 'bob@epsi.fr', amount: '10.00' });

      expect(response.status).toBe(403);
      expect(findRecipient).not.toHaveBeenCalled();
    });
  });

  describe('Consultation', () => {
    it('GET /wallets/:id doit répondre 404 pour le portefeuille d\'un autre utilisateur', async () => {
      authenticateAs();
      vi.spyOn(prisma.wallet, 'findUnique').mockResolvedValueOnce({ id: WALLET_A, userId: 'someone-else' } as any);

      const response = await request(server).get(`/wallets/${WALLET_A}`).set('Authorization', 'Bearer token');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('WALLET_NOT_FOUND');
    });

    it('GET /payments/:id doit répondre 404 pour un identifiant non UUID, sans requête SQL', async () => {
      authenticateAs();
      const findSpy = vi.spyOn(prisma.transaction, 'findFirst');

      const response = await request(server).get('/payments/test-validation').set('Authorization', 'Bearer token');

      expect(response.status).toBe(404);
      expect(findSpy).not.toHaveBeenCalled();
    });
  });

  describe('POST /payments/test-validation (route interne)', () => {
    it('doit être désactivée si PAYMENT_INTERNAL_TOKEN est absent (503)', async () => {
      vi.stubEnv('PAYMENT_INTERNAL_TOKEN', '');

      const response = await request(server).post('/payments/test-validation');

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('INTERNAL_ROUTE_DISABLED');
    });

    it('doit refuser un jeton interne invalide (401)', async () => {
      vi.stubEnv('PAYMENT_INTERNAL_TOKEN', 'secret-interne');

      const response = await request(server).post('/payments/test-validation').set('X-Internal-Token', 'mauvais');

      expect(response.status).toBe(401);
    });

    it('doit répondre 503 FAILED si le paiement de validation échoue (base indisponible)', async () => {
      vi.stubEnv('PAYMENT_INTERNAL_TOKEN', 'secret-interne');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma.wallet, 'findFirst').mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(server).post('/payments/test-validation').set('X-Internal-Token', 'secret-interne');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('FAILED');
      expect(typeof response.body.durationMs).toBe('number');
    });

    it('doit répondre 404 pour un incident inconnu', async () => {
      vi.stubEnv('PAYMENT_INTERNAL_TOKEN', 'secret-interne');
      vi.spyOn(prisma.incident, 'findUnique').mockResolvedValueOnce(null);

      const response = await request(server)
        .post('/payments/test-validation')
        .set('X-Internal-Token', 'secret-interne')
        .send({ incidentId: WALLET_A });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('INCIDENT_NOT_FOUND');
    });
  });

  describe('Routes techniques', () => {
    it('GET /health doit renvoyer 200 lorsque la base est accessible', async () => {
      vi.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([{ '?column?': 1 }] as any);

      const response = await request(server).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'healthy', service: 'epsi-pay-payment' });
    });

    it('GET /docs.json doit documenter les routes publiques et internes', async () => {
      const response = await request(server).get('/docs.json');

      expect(response.status).toBe(200);
      expect(Object.keys(response.body.paths)).toEqual(
        expect.arrayContaining(['/wallets', '/wallets/{id}', '/payments', '/payments/{id}', '/payments/test-validation']),
      );
    });
  });
});

describe('parseAmount', () => {
  it.each([
    ['49.99', '49.99'],
    [12.5, '12.50'],
    ['10000', '10000.00'],
  ])('%j → %s', (input, expected) => {
    expect(parseAmount(input).toFixed(2)).toBe(expected);
  });
});

describe('toHistoryEntryView', () => {
  const transaction = {
    id: 'tx-1',
    reference: 'ref-1',
    type: 'PAYMENT',
    status: 'SUCCESS',
    amount: new Prisma.Decimal('12.5'),
    currency: 'EUR',
    description: null,
    senderWalletId: WALLET_A,
    receiverWalletId: WALLET_B,
    createdAt: new Date(),
    senderWallet: { userId: 'u-a', user: { name: 'Alice', email: 'alice@epsi.fr' } },
    receiverWallet: { userId: 'u-b', user: { name: 'Bob', email: 'bob@epsi.fr' } },
  } as any;

  it('doit indiquer le sens et l\'autre partie selon le portefeuille consulté', () => {
    expect(toHistoryEntryView(transaction, WALLET_A)).toMatchObject({
      amount: '12.50',
      direction: 'DEBIT',
      counterparty: { name: 'Bob', email: 'bob@epsi.fr' },
    });
    expect(toHistoryEntryView(transaction, WALLET_B)).toMatchObject({
      direction: 'CREDIT',
      counterparty: { name: 'Alice', email: 'alice@epsi.fr' },
    });
  });

  it('ne doit pas exposer les identifiants internes des utilisateurs', () => {
    expect(JSON.stringify(toHistoryEntryView(transaction, WALLET_A))).not.toContain('u-b');
  });

  it('doit renvoyer une contrepartie nulle pour un crédit sans émetteur', () => {
    const entry = toHistoryEntryView({ ...transaction, senderWalletId: null, senderWallet: null }, WALLET_B);
    expect(entry).toMatchObject({ direction: 'CREDIT', counterparty: null });
  });
});
