import { app } from './app';
import { prisma } from '@epsi-pay/database';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const server = app.listen(PORT, () => {
  console.log(`[API] Server listening on port ${PORT} (env: ${process.env.NODE_ENV || 'development'})`);
});

const gracefulShutdown = async (signal: string) => {
  console.log(`[API] Received ${signal}. Starting graceful shutdown...`);

  // Fermer le serveur HTTP pour ne plus accepter de nouvelles requêtes
  server.close(async () => {
    console.log('[API] HTTP server closed.');

    try {
      // Déconnecter Prisma proprement
      await prisma.$disconnect();
      console.log('[API] Database connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('[API] Error during database disconnect:', err);
      process.exit(1);
    }
  });

  // Sécurité : forcer l'arrêt si les connexions en cours mettent plus de 10 secondes à se clore
  setTimeout(() => {
    console.error('[API] Graceful shutdown timed out. Forcing process exit.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
