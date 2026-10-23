import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Sources d'auth plutôt que son build CommonJS : sinon auth chargerait sa propre instance Prisma
      // via le require natif, et les mocks posés dans les tests ne l'atteindraient pas
      '@epsi-pay/auth': path.resolve(__dirname, '../auth/src/index.ts'),
    },
  },
});
