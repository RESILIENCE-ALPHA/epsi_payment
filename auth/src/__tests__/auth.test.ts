import http from 'http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { authApp } from '../server';
import { parseTrustProxy } from '../controller';
import { prisma, UserRole, UserStatus } from '@epsi-pay/database';

describe('Service Auth — Endpoints & Résilience Red Team', () => {
  let server: http.Server;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(authApp);
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
  });

  const testPassword = 'PasswordValid123!';
  const hashedPassword = bcrypt.hashSync(testPassword, 10);

  const mockUser = {
    id: 'user-uuid-1234',
    email: 'alice@epsi.fr',
    passwordHash: hashedPassword,
    name: 'Alice Martin',
    role: UserRole.CLIENT,
    status: UserStatus.ACTIVE,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  describe('POST /auth/login', () => {
    it('doit réussir avec des identifiants valides et générer un jeton de session', async () => {
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({ ...mockUser });
      vi.spyOn(prisma.user, 'update').mockResolvedValueOnce({ ...mockUser });
      vi.spyOn(prisma.session, 'create').mockResolvedValueOnce({
        id: 'session-1',
        userId: mockUser.id,
        tokenHash: 'hash-abc',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
        isValid: true,
        expiresAt: new Date(Date.now() + 86400000),
        createdAt: new Date(),
      });
      const loginAttemptSpy = vi.spyOn(prisma.loginAttempt, 'create').mockResolvedValueOnce({} as any);

      const response = await request(server)
        .post('/auth/login')
        .send({ email: 'alice@epsi.fr', password: testPassword });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.token).toBeDefined();
      expect(response.body.user).toMatchObject({
        id: mockUser.id,
        email: 'alice@epsi.fr',
        name: 'Alice Martin',
        role: 'CLIENT',
        status: 'ACTIVE',
      });
      // Vérification enregistrement ML
      expect(loginAttemptSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attemptedEmail: 'alice@epsi.fr',
          targetUserId: mockUser.id,
          isAuthenticated: true,
          failureReason: null,
        }),
      });
    });

    it('doit rejeter avec 401 si le mot de passe est erroné et décrémenter les tentatives', async () => {
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        ...mockUser,
        failedLoginAttempts: 2,
      });
      const userUpdateSpy = vi.spyOn(prisma.user, 'update').mockResolvedValueOnce({} as any);
      const loginAttemptSpy = vi.spyOn(prisma.loginAttempt, 'create').mockResolvedValueOnce({} as any);

      const response = await request(server)
        .post('/auth/login')
        .send({ email: 'alice@epsi.fr', password: 'MauvaisMotDePasse!' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('INVALID_CREDENTIALS');
      expect(response.body.remainingAttempts).toBe(2); // 5 - (2 + 1) = 2

      // Vérification incrémentation du compteur
      expect(userUpdateSpy).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: expect.objectContaining({
          failedLoginAttempts: 3,
        }),
      });

      // Vérification log ML
      expect(loginAttemptSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          attemptedEmail: 'alice@epsi.fr',
          isAuthenticated: false,
          failureReason: 'INVALID_CREDENTIALS',
        }),
      });
    });

    it('doit verrouiller le compte (423 Locked) après 5 échecs consécutifs (Brute Force)', async () => {
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce({
        ...mockUser,
        failedLoginAttempts: 4, // 5ème échec imminent
      });
      const userUpdateSpy = vi.spyOn(prisma.user, 'update').mockResolvedValueOnce({} as any);
      const auditLogSpy = vi.spyOn(prisma.auditLog, 'create').mockResolvedValueOnce({} as any);
      const loginAttemptSpy = vi.spyOn(prisma.loginAttempt, 'create').mockResolvedValueOnce({} as any);

      const response = await request(server)
        .post('/auth/login')
        .send({ email: 'alice@epsi.fr', password: 'MauvaisMotDePasse5!' });

      expect(response.status).toBe(423);
      expect(response.body.error).toBe('ACCOUNT_LOCKED');
      expect(response.body.lockedUntil).toBeDefined();

      // Vérification bascule en status LOCKED
      expect(userUpdateSpy).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        data: expect.objectContaining({
          failedLoginAttempts: 5,
          status: UserStatus.LOCKED,
          lockedUntil: expect.any(Date),
        }),
      });

      // Audit de sécurité pour SIEM / Wazuh
      expect(auditLogSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'BRUTE_FORCE_ACCOUNT_LOCKED',
          severity: 'CRITICAL',
        }),
      });

      // ML trace
      expect(loginAttemptSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          failureReason: 'BRUTE_FORCE_LOCKED',
        }),
      });
    });

    it('doit bloquer immédiatement avec 403 Forbidden si l\'adresse IP est sur liste noire', async () => {
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce({
        id: 'block-1',
        ipAddress: '192.168.1.50',
        reason: 'ML_ANOMALY_BRUTE_FORCE',
        blockedBy: 'AUTO_REMEDIATION',
        isActive: true,
        blockedAt: new Date(),
        expiresAt: null,
      });
      const userFindSpy = vi.spyOn(prisma.user, 'findUnique');
      const loginAttemptSpy = vi.spyOn(prisma.loginAttempt, 'create').mockResolvedValueOnce({} as any);

      const response = await request(server)
        .post('/auth/login')
        .set('X-Forwarded-For', '192.168.1.50')
        .send({ email: 'alice@epsi.fr', password: testPassword });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('IP_BLOCKED');
      expect(userFindSpy).not.toHaveBeenCalled(); // Ne sollicite même pas la table users (résilience)
      expect(loginAttemptSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ipAddress: '192.168.1.50',
          failureReason: 'IP_BLOCKED',
        }),
      });
    });
  });

  describe('Résolution de l\'IP cliente (anti-usurpation X-Forwarded-For)', () => {
    const mockFailedLogin = () => {
      vi.spyOn(prisma.blockedIp, 'findFirst').mockResolvedValueOnce(null);
      vi.spyOn(prisma.user, 'findUnique').mockResolvedValueOnce(null);
      return vi.spyOn(prisma.loginAttempt, 'create').mockResolvedValueOnce({} as any);
    };

    it('doit ignorer une IP forgée par le client et retenir celle ajoutée par la passerelle', async () => {
      const loginAttemptSpy = mockFailedLogin();

      // Le client envoie "6.6.6.6", la passerelle ajoute l'IP réelle de la socket
      const response = await request(server)
        .post('/auth/login')
        .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
        .send({ email: 'inconnu@epsi.fr', password: 'mauvais' });

      expect(response.status).toBe(401);
      expect(loginAttemptSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({ ipAddress: '203.0.113.7' }),
      });
    });

    it('doit normaliser une adresse IPv4 transmise sous forme IPv6 (::ffff:)', async () => {
      const loginAttemptSpy = mockFailedLogin();

      await request(server)
        .post('/auth/login')
        .set('X-Forwarded-For', '::ffff:198.51.100.4')
        .send({ email: 'inconnu@epsi.fr', password: 'mauvais' });

      expect(loginAttemptSpy).toHaveBeenCalledWith({
        data: expect.objectContaining({ ipAddress: '198.51.100.4' }),
      });
    });

    it('parseTrustProxy doit interpréter TRUST_PROXY', () => {
      expect(parseTrustProxy(undefined)).toBe(1);
      expect(parseTrustProxy('2')).toBe(2);
      expect(parseTrustProxy('false')).toBe(false);
      expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    });
  });

  describe('GET /auth/me', () => {
    it('doit renvoyer le profil utilisateur avec un Bearer token valide', async () => {
      vi.spyOn(prisma.session, 'findUnique').mockResolvedValueOnce({
        id: 'session-1',
        userId: mockUser.id,
        tokenHash: 'some-hash',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
        isValid: true,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        user: mockUser,
      } as any);

      const response = await request(server)
        .get('/auth/me')
        .set('Authorization', 'Bearer token_secret_123');

      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({
        id: mockUser.id,
        email: 'alice@epsi.fr',
        name: 'Alice Martin',
      });
      expect(response.body.user.passwordHash).toBeUndefined(); // Jamais de mot de passe exposé
    });

    it('doit refuser l\'accès avec 401 si aucun token n\'est fourni', async () => {
      const response = await request(server).get('/auth/me');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHORIZED');
    });
  });

  describe('POST /auth/logout', () => {
    it('doit révoquer la session active avec un statut 200', async () => {
      vi.spyOn(prisma.session, 'findUnique').mockResolvedValueOnce({
        id: 'session-1',
        userId: mockUser.id,
        tokenHash: 'some-hash',
        isValid: true,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        user: mockUser,
      } as any);
      const updateManySpy = vi.spyOn(prisma.session, 'updateMany').mockResolvedValueOnce({ count: 1 });

      const response = await request(server)
        .post('/auth/logout')
        .set('Authorization', 'Bearer token_to_revoke');

      expect(response.status).toBe(200);
      expect(response.body.message).toContain('Déconnexion réussie');
      expect(updateManySpy).toHaveBeenCalledWith({
        where: expect.objectContaining({ isValid: true }),
        data: { isValid: false },
      });
    });
  });

  describe('Routes techniques (sondes & documentation)', () => {
    it('GET /health doit renvoyer 200 lorsque la base est accessible', async () => {
      vi.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([{ '?column?': 1 }] as any);

      const response = await request(server).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'healthy', service: 'epsi-pay-auth', checks: { database: 'up' } });
    });

    it('GET /auth/health doit renvoyer 503 lorsque la base est indisponible', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Connection refused to postgres:5432'));

      const response = await request(server).get('/auth/health');

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ status: 'degraded', checks: { database: 'down' } });
    });

    it('GET /health ne doit pas divulguer le détail de l\'erreur en production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Connection refused to postgres:5432'));

      const response = await request(server).get('/health');
      vi.unstubAllEnvs();

      expect(response.status).toBe(503);
      expect(response.body.checks).toEqual({ database: 'down' });
    });

    it('GET /auth/docs.json doit exposer les endpoints auth', async () => {
      const response = await request(server).get('/auth/docs.json');

      expect(response.status).toBe(200);
      expect(response.body.info.title).toBe('EPSI Pay Auth');
      expect(response.body.paths['/auth/login']).toBeDefined();
      expect(response.body.paths['/auth/logout']).toBeDefined();
      expect(response.body.paths['/auth/me']).toBeDefined();
    });

    it('doit renvoyer une erreur 500 en JSON si la base tombe pendant un login', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma.blockedIp, 'findFirst').mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(server)
        .post('/auth/login')
        .send({ email: 'alice@epsi.fr', password: testPassword });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal Server Error');
    });
  });
});
