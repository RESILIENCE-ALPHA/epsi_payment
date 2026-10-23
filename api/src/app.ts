import express, { Express, Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { prisma } from '@epsi-pay/database';
import { swaggerSpec } from './swagger';
import { createServiceProxy, parseTrustProxy, PublicRoute } from './serviceProxy';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL ?? 'http://localhost:3001';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3002';
const UPSTREAM_TIMEOUT_MS = process.env.UPSTREAM_TIMEOUT_MS
  ? parseInt(process.env.UPSTREAM_TIMEOUT_MS, 10)
  : 5000;
// Swagger est une carte de l'API : actif en dev, désactivé en production sauf ENABLE_DOCS=true
const ENABLE_DOCS = process.env.ENABLE_DOCS
  ? process.env.ENABLE_DOCS === 'true'
  : process.env.NODE_ENV !== 'production';

// Routes exposées publiquement par service ; sondes, specs et routes internes restent inaccessibles
const AUTH_PUBLIC_ROUTES: PublicRoute[] = [
  { method: 'POST', path: '/auth/login' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'GET', path: '/auth/me' },
];

// POST /payments/test-validation est volontairement absent : réservé au moteur de remédiation (réseau interne)
const PAYMENT_PUBLIC_ROUTES: PublicRoute[] = [
  { method: 'GET', path: '/wallets' },
  { method: 'GET', path: '/wallets/:id' },
  { method: 'POST', path: '/payments' },
  { method: 'GET', path: '/payments/:id' },
];

// Spécifications OpenAPI agrégées par la passerelle (récupérées côté serveur sur le réseau interne)
const SERVICE_SPECS: Record<string, string> = {
  auth: `${AUTH_SERVICE_URL}/docs.json`,
  payment: `${PAYMENT_SERVICE_URL}/docs.json`,
};

export const app: Express = express();

// Proxys de confiance devant la passerelle (nginx du front, Ingress) : détermine l'IP cliente réelle
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

// Middlewares fondamentaux
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Passerelle vers le service auth (monté avant les parsers : le corps est relayé brut)
app.use('/auth', createServiceProxy({
  serviceName: 'auth',
  baseUrl: AUTH_SERVICE_URL,
  timeoutMs: UPSTREAM_TIMEOUT_MS,
  routes: AUTH_PUBLIC_ROUTES,
}));

app.use(['/wallets', '/payments'], createServiceProxy({
  serviceName: 'payment',
  baseUrl: PAYMENT_SERVICE_URL,
  timeoutMs: UPSTREAM_TIMEOUT_MS,
  routes: PAYMENT_PUBLIC_ROUTES,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (ENABLE_DOCS) {
  // Spec d'un service interne, relue à chaque appel pour refléter la version déployée
  app.get('/docs/specs/:service.json', async (req: Request, res: Response) => {
    const specUrl = SERVICE_SPECS[req.params.service as string];
    if (!specUrl) {
      res.status(404).json({ error: 'Not Found', message: `Unknown service ${req.params.service}` });
      return;
    }
    try {
      const upstream = await fetch(specUrl, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      res.json(await upstream.json());
    } catch (error) {
      console.error(`[API Gateway] Unable to load ${req.params.service} spec:`, error);
      res.status(503).json({ error: 'SERVICE_UNAVAILABLE', service: req.params.service });
    }
  });

  // Documentation interactive Swagger UI : agrège la spec de chaque service
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(null, {
    customSiteTitle: 'EPSI Pay — API Documentation',
    explorer: true,
    swaggerOptions: {
      urls: [
        { url: '/docs.json', name: 'API Gateway' },
        { url: '/docs/specs/auth.json', name: 'Auth' },
        { url: '/docs/specs/payment.json', name: 'Payment' },
      ],
      docExpansion: 'list',
      filter: true,
    },
  }));

  // Expose la spécification OpenAPI brute en JSON
  app.get('/docs.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

/**
 * @openapi
 * /:
 *   get:
 *     summary: Informations générales du service
 *     description: Retourne les métadonnées du service API (nom, version, statut opérationnel).
 *     tags:
 *       - Système
 *     responses:
 *       200:
 *         description: Service opérationnel
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ServiceInfo'
 */
app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    service: 'epsi-pay-api',
    status: 'operational',
    version: '1.0.0',
    description: 'Plateforme de paiement résiliente - Project RESILIENCE-ALPHA',
    timestamp: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Sonde de santé du service
 *     description: >
 *       Vérifie l'état opérationnel de l'API et la connectivité avec la base de données PostgreSQL.
 *       Utilisée comme sonde **liveness** et **readiness** par Kubernetes.
 *     tags:
 *       - Système
 *     responses:
 *       200:
 *         description: Service et base de données opérationnels
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 *       503:
 *         description: Service dégradé — base de données inaccessible
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthStatus'
 */
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: {
        database: 'up',
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown database error';
    console.error('[API] Health check failed:', reason);
    res.status(503).json({
      status: 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: {
        database: 'down',
        // Le détail (hôte, port, message PostgreSQL) reste dans les logs en production
        ...(process.env.NODE_ENV === 'production' ? {} : { error: reason }),
      },
    });
  }
});

// Middleware 404 pour les routes inconnues
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
  });
});

// Middleware de gestion d'erreurs globales
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[API Error]:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    timestamp: new Date().toISOString(),
  });
});
