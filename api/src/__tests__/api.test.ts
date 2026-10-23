import http from 'http';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';

// Services auth et payment volontairement injoignables (port 1) : on vérifie le comportement dégradé de la passerelle
vi.hoisted(() => {
  process.env.AUTH_SERVICE_URL = 'http://127.0.0.1:1';
  process.env.PAYMENT_SERVICE_URL = 'http://127.0.0.1:1';
});

import { app } from '../app';
import { prisma } from '@epsi-pay/database';

describe('API Service - Endpoints & Résilience', () => {
  let server: http.Server;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      // Écoute sur le loopback IPv6 pour une isolation réseau optimale
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

  describe('GET /docs (Swagger UI)', () => {
    it('doit retourner la page Swagger UI avec un statut 200', async () => {
      const response = await request(server).get('/docs/');
      expect(response.status).toBe(200);
      expect(response.text).toContain('swagger');
    });

    it('doit exposer la spécification OpenAPI en JSON sur /docs.json', async () => {
      const response = await request(server).get('/docs.json');
      expect(response.status).toBe(200);
      expect(response.body.openapi).toBe('3.0.0');
      expect(response.body.info.title).toBe('EPSI Pay API');
      expect(response.body.paths).toBeDefined();
    });
  });

  describe('GET / (Informations générales)', () => {
    it('doit renvoyer un statut 200 avec les métadonnées du service', async () => {
      const response = await request(server).get('/');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        service: 'epsi-pay-api',
        status: 'operational',
        version: '1.0.0',
        description: 'Plateforme de paiement résiliente - Project RESILIENCE-ALPHA',
      });
      expect(response.body.timestamp).toBeDefined();
    });

    it('doit renvoyer les en-têtes CORS appropriés', async () => {
      const response = await request(server).options('/');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['access-control-allow-methods']).toContain('GET');
    });
  });

  describe('GET /health (Sonde de santé & Résilience DB)', () => {
    it('doit renvoyer un statut 200 et status "healthy" lorsque la base de données est accessible', async () => {
      vi.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([{ '?column?': 1 }] as any);

      const response = await request(server).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'healthy',
        checks: {
          database: 'up',
        },
      });
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.timestamp).toBeDefined();
    });

    it('doit renvoyer un statut 503 et status "degraded" lorsque la base de données est indisponible', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Connection refused to postgres:5432'));

      const response = await request(server).get('/health');

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        status: 'degraded',
        checks: {
          database: 'down',
          error: 'Connection refused to postgres:5432',
        },
      });
      expect(typeof response.body.uptime).toBe('number');
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /health en production', () => {
    it('ne doit pas divulguer le détail de l\'erreur base de données', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Connection refused to postgres:5432'));

      const response = await request(server).get('/health');

      expect(response.status).toBe(503);
      expect(response.body.checks).toEqual({ database: 'down' });
      expect(JSON.stringify(response.body)).not.toContain('postgres');
    });
  });

  describe('Passerelle /auth', () => {
    it('doit répondre 503 en JSON lorsque le service auth est injoignable', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await request(server)
        .post('/auth/login')
        .send({ email: 'alice@epsi.fr', password: 'randomPassword123' });

      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        error: 'SERVICE_UNAVAILABLE',
        service: 'auth',
      });
    });

    it.each([
      ['GET', '/auth/health'],
      ['GET', '/auth/login'],
      ['POST', '/auth/admin'],
      ['GET', '/auth/me/extra'],
      ['GET', '/auth/docs.json'],
    ])('ne doit pas relayer une route non déclarée (%s %s) : 404', async (method, path) => {
      const response = await request(server)[method.toLowerCase() as 'get' | 'post'](path);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
    });

    it('doit répondre 503 si la spec d\'un service est indisponible, 404 si le service est inconnu', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      expect((await request(server).get('/docs/specs/auth.json')).status).toBe(503);
      expect((await request(server).get('/docs/specs/inconnu.json')).status).toBe(404);
    });

    it('doit référencer la spécification du service auth dans Swagger UI', async () => {
      const response = await request(server).get('/docs/swagger-ui-init.js');
      expect(response.status).toBe(200);
      expect(response.text).toContain('/docs/specs/auth.json');
      expect(response.text).toContain('/docs/specs/payment.json');
    });
  });

  describe('Passerelle /wallets et /payments', () => {
    it.each([
      ['GET', '/wallets'],
      ['GET', '/wallets/6e092721-e7c3-4a28-a4d6-f70e0983a49c'],
      ['POST', '/payments'],
      ['GET', '/payments/6e092721-e7c3-4a28-a4d6-f70e0983a49c'],
    ])('doit relayer %s %s vers payment (503 lorsqu\'il est injoignable)', async (method, path) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await request(server)[method.toLowerCase() as 'get' | 'post'](path);

      expect(response.status).toBe(503);
      expect(response.body.service).toBe('payment');
    });

    it.each([
      ['POST', '/payments/test-validation'],
      ['GET', '/payments'],
      ['DELETE', '/wallets/6e092721-e7c3-4a28-a4d6-f70e0983a49c'],
      ['GET', '/wallets/abc/transactions'],
    ])('ne doit pas relayer %s %s : 404', async (method, path) => {
      const response = await request(server)[method.toLowerCase() as 'get' | 'post' | 'delete'](path);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Not Found');
    });
  });

  describe('ENABLE_DOCS=false', () => {
    it('ne doit exposer ni Swagger UI ni les spécifications', async () => {
      vi.stubEnv('ENABLE_DOCS', 'false');
      vi.resetModules();
      const { app: appWithoutDocs } = await import('../app');

      for (const path of ['/docs/', '/docs.json', '/docs/specs/auth.json']) {
        const response = await request(appWithoutDocs).get(path);
        expect(response.status, path).toBe(404);
      }
    });
  });

  describe('Gestion des routes inconnues (404)', () => {
    it('doit renvoyer un code 404 au format JSON pour une URL inexistante', async () => {
      const response = await request(server).get('/route-inexistante-xyz');

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({
        error: 'Not Found',
      });
      expect(response.body.message).toContain('/route-inexistante-xyz');
    });
  });
});
