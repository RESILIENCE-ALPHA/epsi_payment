import express, { Express, Request, Response, NextFunction, Router } from 'express';
import { prisma } from '@epsi-pay/database';
import { authRouter } from './routes';
import { swaggerSpec } from './swagger';
import { parseTrustProxy } from './controller';

export const authApp: Express = express();

// Nombre de proxys de confiance devant auth : détermine quelle entrée de X-Forwarded-For est l'IP réelle
authApp.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

authApp.use(express.json());
authApp.use(express.urlencoded({ extended: true }));

// Routes techniques : sondes Kubernetes et spécification OpenAPI
const systemRouter: Router = Router();

systemRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'healthy',
      service: 'epsi-pay-auth',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: { database: 'up' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown database error';
    console.error('[AUTH SERVICE] Health check failed:', reason);
    res.status(503).json({
      status: 'degraded',
      service: 'epsi-pay-auth',
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

// Montage sur /auth (chemin relayé par la passerelle API / l'Ingress) et sur la racine (accès direct)
authApp.use('/auth', systemRouter, authRouter);
authApp.use('/', systemRouter, authRouter);

authApp.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
    timestamp: new Date().toISOString(),
  });
});

// Une base indisponible ne doit pas faire fuiter une page d'erreur HTML : réponse JSON homogène
authApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[AUTH SERVICE] Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.AUTH_PORT
  ? parseInt(process.env.AUTH_PORT, 10)
  : process.env.PORT
  ? parseInt(process.env.PORT, 10)
  : 3001;

if (require.main === module) {
  const server = authApp.listen(PORT, () => {
    console.log(`[AUTH SERVICE] Listening autonomously on port ${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`[AUTH SERVICE] Received ${signal}. Starting graceful shutdown...`);
    server.close(async () => {
      try {
        await prisma.$disconnect();
        console.log('[AUTH SERVICE] Database disconnected cleanly.');
        process.exit(0);
      } catch (err) {
        console.error('[AUTH SERVICE] Disconnect error:', err);
        process.exit(1);
      }
    });

    setTimeout(() => {
      console.error('[AUTH SERVICE] Shutdown timeout. Forcing exit.');
      process.exit(1);
    }, 5000).unref();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
