import express, { Express, Request, Response, NextFunction, Router } from 'express';
import { prisma } from '@epsi-pay/database';
import { parseTrustProxy } from '@epsi-pay/auth';
import { paymentRouter } from './routes';
import { swaggerSpec } from './swagger';
import { PaymentError } from './errors';

export const paymentApp: Express = express();

// Nombre de proxys de confiance devant payment : détermine quelle entrée de X-Forwarded-For est l'IP réelle
paymentApp.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

paymentApp.use(express.json());
paymentApp.use(express.urlencoded({ extended: true }));

// Routes techniques : sondes Kubernetes et spécification OpenAPI
const systemRouter: Router = Router();

systemRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'healthy',
      service: 'epsi-pay-payment',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { database: 'up' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown database error';
    console.error('[PAYMENT SERVICE] Health check failed:', reason);
    res.status(503).json({
      status: 'degraded',
      service: 'epsi-pay-payment',
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

systemRouter.get('/docs.json', (_req: Request, res: Response) => {
  res.json(swaggerSpec);
});

// Chemins identiques à ceux de la passerelle (/wallets, /payments) : elle les relaie sans réécriture.
// /health et /docs.json restent internes (non déclarés dans la liste blanche de la passerelle).
paymentApp.use(systemRouter, paymentRouter);

paymentApp.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
  });
});

// Une base indisponible ne doit pas faire fuiter une page d'erreur HTML : réponse JSON homogène
paymentApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof PaymentError) {
    res.status(err.status).json({ error: err.code, message: err.message, timestamp: new Date().toISOString() });
    return;
  }
  // Corps JSON illisible : erreur client, pas une panne
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'INVALID_JSON', message: 'Corps de requête JSON invalide.', timestamp: new Date().toISOString() });
    return;
  }
  console.error('[PAYMENT SERVICE] Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PAYMENT_PORT
  ? parseInt(process.env.PAYMENT_PORT, 10)
  : process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 3002;

if (require.main === module) {
  const server = paymentApp.listen(PORT, () => {
    console.log(`[PAYMENT SERVICE] Listening autonomously on port ${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`[PAYMENT SERVICE] Received ${signal}. Starting graceful shutdown...`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
        console.log('[PAYMENT SERVICE] Database disconnected cleanly.');
        process.exit(0);
      } catch (err) {
        console.error('[PAYMENT SERVICE] Disconnect error:', err);
        process.exit(1);
      }
    });

    setTimeout(() => {
      console.error('[PAYMENT SERVICE] Shutdown timeout. Forcing exit.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
