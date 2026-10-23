import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createServiceProxy, isPublicRoute, parseTrustProxy, PublicRoute } from '../serviceProxy';

describe('createServiceProxy — relais vers un service interne', () => {
  let upstream: http.Server;
  let upstreamUrl: string;
  let lastUpstreamRequest: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

  beforeAll(async () => {
    // Faux service amont : renvoie ce qu'il a reçu, ou ne répond jamais sur /slow
    upstream = http.createServer((req, res) => {
      if (req.url === '/svc/slow') return;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        lastUpstreamRequest = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const routes: PublicRoute[] = [
    { method: 'POST', path: '/svc/login' },
    { method: 'GET', path: '/svc/slow' },
  ];

  const buildApp = (timeoutMs = 2000, trustProxy: number | boolean = false) => {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.use('/svc', createServiceProxy({ serviceName: 'svc', baseUrl: upstreamUrl, timeoutMs, routes }));
    app.use((_req, res) => {
      res.status(404).json({ error: 'Not Found' });
    });
    return app;
  };

  it('doit relayer méthode, chemin, corps et en-têtes, puis renvoyer la réponse amont', async () => {
    const response = await request(buildApp())
      .post('/svc/login?from=test')
      .set('Authorization', 'Bearer abc')
      .send({ email: 'alice@epsi.fr' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers['x-upstream']).toBe('yes');

    expect(lastUpstreamRequest.method).toBe('POST');
    expect(lastUpstreamRequest.url).toBe('/svc/login?from=test');
    expect(lastUpstreamRequest.headers.authorization).toBe('Bearer abc');
    expect(JSON.parse(lastUpstreamRequest.body)).toEqual({ email: 'alice@epsi.fr' });
    expect(lastUpstreamRequest.headers['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('doit ignorer un X-Forwarded-For forgé quand aucun proxy n\'est de confiance', async () => {
    await request(buildApp()).post('/svc/login').set('X-Forwarded-For', '6.6.6.6').send({});

    expect(lastUpstreamRequest.headers['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('doit transmettre uniquement l\'IP posée par le proxy de confiance (nginx du front)', async () => {
    // Le client forge 6.6.6.6, nginx ajoute l'IP réelle 203.0.113.7
    await request(buildApp(2000, 1)).post('/svc/login').set('X-Forwarded-For', '6.6.6.6, 203.0.113.7').send({});

    expect(lastUpstreamRequest.headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('doit répondre 504 lorsque le service amont dépasse le délai', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(buildApp(100)).get('/svc/slow');

    expect(response.status).toBe(504);
    expect(response.body).toMatchObject({ error: 'GATEWAY_TIMEOUT', service: 'svc' });
  });

  it('doit passer la main au middleware suivant pour une route non déclarée, sans appeler le service', async () => {
    lastUpstreamRequest = undefined as any;

    const response = await request(buildApp()).get('/svc/internal');

    expect(response.status).toBe(404);
    expect(lastUpstreamRequest).toBeUndefined();
  });
});

describe('isPublicRoute — correspondance de la liste blanche', () => {
  const routes: PublicRoute[] = [
    { method: 'GET', path: '/payments/:id' },
    { method: 'POST', path: '/payments' },
  ];

  it.each([
    ['GET', '/payments/42', true],
    ['GET', '/payments/42/', true],
    ['POST', '/payments', true],
    ['DELETE', '/payments/42', false],
    ['GET', '/payments', false],
    ['GET', '/payments/42/refund', false],
  ])('%s %s → %s', (method, path, expected) => {
    expect(isPublicRoute(routes, method, path)).toBe(expected);
  });
});

describe('parseTrustProxy (passerelle)', () => {
  it('ne doit faire confiance à aucun proxy par défaut', () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy('')).toBe(0);
  });

  it('doit accepter un nombre de sauts, un booléen ou des sous-réseaux', () => {
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
