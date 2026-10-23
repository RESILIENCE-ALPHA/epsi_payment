import crypto from 'crypto';
import http from 'http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { prisma, Prisma, UserRole, IncidentType } from '@epsi-pay/database';
import { hashToken } from '@epsi-pay/auth';
import { paymentApp } from '../server';

/**
 * Tests d'intégration sur un vrai PostgreSQL : idempotence, absence de découvert sous concurrence,
 * deadlocks, preuve de remédiation. Les mocks ne peuvent pas prouver ces garanties.
 *
 * Lancement (base Docker Compose démarrée) :
 *   PAYMENT_INTEGRATION=1 DATABASE_URL=postgresql://...@localhost:5432/... npm run test:payment
 *
 * Chaque exécution crée ses propres utilisateurs (emails uniques) et les supprime à la fin.
 */
describe.runIf(process.env.PAYMENT_INTEGRATION === '1')('Service Payment — intégration PostgreSQL', () => {
  const runId = crypto.randomUUID().slice(0, 8);
  let server: http.Server;
  const userIds: string[] = [];
  const walletIds: string[] = [];

  interface TestAccount {
    userId: string;
    walletId: string;
    token: string;
    email: string;
  }

  async function createAccount(name: string, balance: string): Promise<TestAccount> {
    const email = `it-${runId}-${name}@epsi-pay.test`;
    const user = await prisma.user.create({
      data: { email, name, passwordHash: 'not-used', role: UserRole.CLIENT },
    });
    const wallet = await prisma.wallet.create({ data: { userId: user.id, balance: new Prisma.Decimal(balance) } });
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    userIds.push(user.id);
    walletIds.push(wallet.id);
    return { userId: user.id, walletId: wallet.id, token, email };
  }

  const balanceOf = async (walletId: string) =>
    (await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } })).balance.toFixed(2);

  const pay = (from: TestAccount, to: TestAccount, amount: string, key = crypto.randomUUID()) =>
    request(server)
      .post('/payments')
      .set('Authorization', `Bearer ${from.token}`)
      .set('Idempotency-Key', key)
      .send({ senderWalletId: from.walletId, receiverWalletId: to.walletId, amount });

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(paymentApp);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    const txFilter = { OR: [{ senderWalletId: { in: walletIds } }, { receiverWalletId: { in: walletIds } }] };
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { transaction: txFilter }] } });
    await prisma.transaction.deleteMany({ where: txFilter });
    await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('doit effectuer un paiement : débit, crédit, transaction SUCCESS et audit', async () => {
    const alice = await createAccount('alice', '100.00');
    const bob = await createAccount('bob', '0.00');

    const response = await pay(alice, bob, '30.50');

    expect(response.status).toBe(201);
    expect(response.body.payment).toMatchObject({ status: 'SUCCESS', amount: '30.50', type: 'PAYMENT' });
    expect(await balanceOf(alice.walletId)).toBe('69.50');
    expect(await balanceOf(bob.walletId)).toBe('30.50');

    const audit = await prisma.auditLog.findFirst({ where: { transactionId: response.body.payment.id } });
    expect(audit?.action).toBe('PAYMENT_SUCCESS');

    // Le destinataire voit le paiement, un tiers non
    const carol = await createAccount('carol', '0.00');
    const asBob = await request(server).get(`/payments/${response.body.payment.id}`).set('Authorization', `Bearer ${bob.token}`);
    const asCarol = await request(server).get(`/payments/${response.body.payment.id}`).set('Authorization', `Bearer ${carol.token}`);
    expect(asBob.status).toBe(200);
    expect(asCarol.status).toBe(404);
  });

  it('doit payer un destinataire désigné par e-mail et l\'afficher dans les deux historiques', async () => {
    const alice = await createAccount('mail-alice', '50.00');
    const bob = await createAccount('mail-bob', '0.00');

    const response = await request(server)
      .post('/payments')
      .set('Authorization', `Bearer ${alice.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ senderWalletId: alice.walletId, recipientEmail: `  ${bob.email.toUpperCase()} `, amount: '12.50' });

    expect(response.status).toBe(201);
    expect(response.body.payment.receiverWalletId).toBe(bob.walletId);
    expect(await balanceOf(bob.walletId)).toBe('12.50');

    const aliceHistory = await request(server).get(`/wallets/${alice.walletId}`).set('Authorization', `Bearer ${alice.token}`);
    const bobHistory = await request(server).get(`/wallets/${bob.walletId}`).set('Authorization', `Bearer ${bob.token}`);
    expect(aliceHistory.body.transactions[0]).toMatchObject({
      direction: 'DEBIT',
      counterparty: { name: 'mail-bob', email: bob.email },
    });
    expect(bobHistory.body.transactions[0]).toMatchObject({
      direction: 'CREDIT',
      counterparty: { name: 'mail-alice', email: alice.email },
    });
  });

  it('doit répondre 404 RECEIVER_NOT_FOUND pour un e-mail inconnu ou celui de l\'émetteur, sans débit', async () => {
    const alice = await createAccount('mail-self', '50.00');

    for (const recipientEmail of [`inconnu-${runId}@epsi-pay.test`, alice.email]) {
      const response = await request(server)
        .post('/payments')
        .set('Authorization', `Bearer ${alice.token}`)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ senderWalletId: alice.walletId, recipientEmail, amount: '5.00' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('RECEIVER_NOT_FOUND');
    }
    expect(await balanceOf(alice.walletId)).toBe('50.00');
  });

  it('doit rejouer une même Idempotency-Key sans second débit', async () => {
    const alice = await createAccount('idem-a', '100.00');
    const bob = await createAccount('idem-b', '0.00');
    const key = `retry-${runId}-0001`;

    const first = await pay(alice, bob, '10.00', key);
    const retry = await pay(alice, bob, '10.00', key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.payment.id).toBe(first.body.payment.id);
    expect(await balanceOf(alice.walletId)).toBe('90.00');

    const reused = await pay(alice, bob, '99.00', key);
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('doit gérer 10 requêtes simultanées avec la même clé : un seul débit', async () => {
    const alice = await createAccount('idem-burst-a', '100.00');
    const bob = await createAccount('idem-burst-b', '0.00');
    const key = `burst-${runId}-0001`;

    const responses = await Promise.all(Array.from({ length: 10 }, () => pay(alice, bob, '5.00', key)));

    const ids = new Set(responses.filter((r) => r.status < 300).map((r) => r.body.payment.id));
    expect(ids.size).toBe(1);
    expect(await balanceOf(alice.walletId)).toBe('95.00');
  });

  it('doit refuser un solde insuffisant (422) sans toucher au solde, et auditer le rejet', async () => {
    const alice = await createAccount('poor-a', '5.00');
    const bob = await createAccount('poor-b', '0.00');

    const response = await pay(alice, bob, '5.01');

    expect(response.status).toBe(422);
    expect(response.body.error).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(alice.walletId)).toBe('5.00');
    const audit = await prisma.auditLog.findFirst({ where: { userId: alice.userId, action: 'PAYMENT_REJECTED' } });
    expect(audit?.details).toMatchObject({ reason: 'INSUFFICIENT_FUNDS' });
  });

  it('doit refuser de débiter le portefeuille d\'un autre utilisateur (404)', async () => {
    const alice = await createAccount('thief-victim', '100.00');
    const mallory = await createAccount('thief', '0.00');

    const response = await request(server)
      .post('/payments')
      .set('Authorization', `Bearer ${mallory.token}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ senderWalletId: alice.walletId, receiverWalletId: mallory.walletId, amount: '50.00' });

    expect(response.status).toBe(404);
    expect(await balanceOf(alice.walletId)).toBe('100.00');
  });

  it('ne doit jamais créer de découvert sous 20 débits concurrents', async () => {
    const alice = await createAccount('race-a', '100.00');
    const bob = await createAccount('race-b', '0.00');

    const responses = await Promise.all(Array.from({ length: 20 }, () => pay(alice, bob, '10.00')));

    // Verrou pessimiste : les débits passent un par un, exactement 10 réussissent puis solde insuffisant
    const succeeded = responses.filter((r) => r.status === 201).length;
    const unexpected = responses.filter((r) => ![201, 422].includes(r.status));
    expect(unexpected.map((r) => r.body)).toEqual([]);
    expect(succeeded).toBe(10);

    const aliceBalance = new Prisma.Decimal(await balanceOf(alice.walletId));
    const bobBalance = new Prisma.Decimal(await balanceOf(bob.walletId));
    expect(aliceBalance.gte(0)).toBe(true);
    expect(bobBalance.toFixed(2)).toBe(new Prisma.Decimal(succeeded * 10).toFixed(2));
    expect(aliceBalance.plus(bobBalance).toFixed(2)).toBe('100.00');
  });

  it('doit absorber des virements croisés simultanés A→B / B→A sans erreur 500', async () => {
    const a = await createAccount('cross-a', '100.00');
    const b = await createAccount('cross-b', '100.00');

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? pay(a, b, '1.00') : pay(b, a, '1.00'))),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
    const total = new Prisma.Decimal(await balanceOf(a.walletId)).plus(await balanceOf(b.walletId));
    expect(total.toFixed(2)).toBe('200.00');
  });

  it('doit refuser un paiement depuis une IP bloquée', async () => {
    const alice = await createAccount('blocked-a', '100.00');
    const bob = await createAccount('blocked-b', '0.00');
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const block = await prisma.blockedIp.create({ data: { ipAddress: ip, reason: `IT_${runId}` } });

    try {
      const response = await pay(alice, bob, '1.00').set('X-Forwarded-For', ip);
      expect(response.status).toBe(403);
      expect(await balanceOf(alice.walletId)).toBe('100.00');
    } finally {
      await prisma.blockedIp.delete({ where: { id: block.id } });
    }
  });

  it('POST /payments/test-validation doit émettre un VALIDATION_TEST et enregistrer la preuve de remédiation', async () => {
    const system = await createAccount('validation-sender', '10.00');
    const merchant = await createAccount('validation-receiver', '0.00');
    vi.stubEnv('PAYMENT_INTERNAL_TOKEN', 'secret-interne');
    vi.stubEnv('VALIDATION_SENDER_EMAIL', system.email);
    vi.stubEnv('VALIDATION_RECEIVER_EMAIL', merchant.email);
    const incident = await prisma.incident.create({ data: { incidentType: IncidentType.BRUTE_FORCE_AUTH } });

    try {
      const response = await request(server)
        .post('/payments/test-validation')
        .set('X-Internal-Token', 'secret-interne')
        .send({ incidentId: incident.id });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'SUCCESS', payment: { type: 'VALIDATION_TEST', amount: '0.01' } });
      expect(await balanceOf(merchant.walletId)).toBe('0.01');

      const proof = await prisma.remediationLog.findFirst({ where: { incidentId: incident.id } });
      expect(proof).toMatchObject({ actionTaken: 'TEST_PAYMENT_VERIFIED', isSuccess: true });
      expect(proof?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.unstubAllEnvs();
      await prisma.incident.delete({ where: { id: incident.id } });
    }
  });
});
