import fs from 'fs';
import { spawn } from 'child_process';
import { PrismaClient } from '@prisma/client';

export interface InitOptions {
  databaseUrl?: string;
  schemaPath?: string;
  seedType?: 'standard' | '10k';
  seedMode?: SeedMode;
  maxRetries?: number;
  retryIntervalMs?: number;
}

export interface StepResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Exécute une commande système et capture sa sortie
 */
export function runCommand(command: string, args: string[]): Promise<StepResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Command exited with code ${code}`,
        });
      }
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        output: stdout,
        error: err.message,
      });
    });
  });
}

export const commandRunner = {
  run: runCommand,
};

/**
 * Sonde de connectivité avec boucle de réessai (résilience K8s)
 */
export async function waitForDatabase(
  client: PrismaClient,
  maxRetries = 10,
  retryIntervalMs = 3000
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.$queryRaw`SELECT 1`;
      console.log(`[DB-INIT] ✅ Connectivité PostgreSQL validée à la tentative ${attempt}/${maxRetries}.`);
      return true;
    } catch (err) {
      console.warn(
        `[DB-INIT] ⏳ Attente de PostgreSQL (${attempt}/${maxRetries}) : ${(err as Error).message}. Nouvelle tentative dans ${retryIntervalMs / 1000}s...`
      );
      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, retryIntervalMs));
      }
    }
  }
  return false;
}

/** Migration initiale : sert de point de départ aux bases créées avant les migrations (ex-`db push`) */
export const BASELINE_MIGRATION = '0_init';

/** Clé du verrou PostgreSQL qui empêche deux jobs d'initialisation de tourner en même temps */
export const INIT_LOCK_KEY = 'epsi-pay-db-init';

/**
 * Stratégie de seed :
 * - `if-empty` (défaut) : peuple uniquement une base sans utilisateur → un redémarrage ne touche à rien ;
 * - `reset` : efface et recrée le jeu de démo (refusé en production sans ALLOW_DATA_RESET=true) ;
 * - `never` : schéma uniquement.
 */
export type SeedMode = 'if-empty' | 'reset' | 'never';

export function resolveSeedMode(env: NodeJS.ProcessEnv = process.env): SeedMode {
  // Compatibilité avec l'ancienne variable
  if (env.SKIP_SEED === 'true') return 'never';

  const mode = env.SEED_MODE ?? 'if-empty';
  if (mode !== 'if-empty' && mode !== 'reset' && mode !== 'never') {
    throw new Error(`SEED_MODE invalide : "${mode}" (attendu : if-empty, reset ou never).`);
  }
  if (mode === 'reset' && env.NODE_ENV === 'production' && env.ALLOW_DATA_RESET !== 'true') {
    throw new Error('SEED_MODE=reset efface toutes les données : refusé en production sans ALLOW_DATA_RESET=true.');
  }
  return mode;
}

async function tableExists(client: PrismaClient, table: string): Promise<boolean> {
  const rows = await client.$queryRaw<{ exists: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS "exists"`;
  return rows[0]?.exists === true;
}

/**
 * Applique les migrations versionnées (`prisma migrate deploy`) : jamais de perte de données silencieuse,
 * contrairement à `db push --accept-data-loss`.
 *
 * Une base déjà créée par `db push` (tables présentes, pas d'historique de migrations) est d'abord
 * marquée comme étant à jour de la migration initiale, sans rien rejouer.
 */
export async function deploySchema(client: PrismaClient, schemaPath = 'prisma/schema.prisma'): Promise<StepResult> {
  const hasHistory = await tableExists(client, '_prisma_migrations');
  const hasTables = await tableExists(client, 'users');

  if (!hasHistory && hasTables) {
    console.log(`[DB-INIT] 📌 Base existante sans historique de migrations : rattachement à ${BASELINE_MIGRATION}...`);
    const baseline = await commandRunner.run('npx', [
      'prisma',
      'migrate',
      'resolve',
      '--applied',
      BASELINE_MIGRATION,
      `--schema=${schemaPath}`,
    ]);
    if (!baseline.success) return baseline;
  }

  console.log(`[DB-INIT] 🚀 Application des migrations Prisma (${schemaPath})...`);
  return commandRunner.run('npx', ['prisma', 'migrate', 'deploy', `--schema=${schemaPath}`]);
}

export async function isDatabaseEmpty(client: PrismaClient): Promise<boolean> {
  return (await client.user.count()) === 0;
}

/**
 * Exécute `fn` sous verrou consultatif PostgreSQL (le client doit n'avoir qu'une connexion,
 * le verrou étant attaché à la session SQL).
 */
export async function withInitLock<T>(client: PrismaClient, fn: () => Promise<T>): Promise<T> {
  console.log('[DB-INIT] 🔒 Acquisition du verrou d\'initialisation...');
  await client.$executeRaw`SELECT pg_advisory_lock(hashtext(${INIT_LOCK_KEY}))`;
  try {
    return await fn();
  } finally {
    await client.$executeRaw`SELECT pg_advisory_unlock(hashtext(${INIT_LOCK_KEY}))`;
  }
}

/**
 * Lance le peuplement de la base (standard ou 10k)
 */
export async function seedDatabase(seedType: 'standard' | '10k' = 'standard'): Promise<StepResult> {
  const tsPath = seedType === '10k' ? 'prisma/seed-10k.ts' : 'prisma/seed.ts';
  const jsPath = seedType === '10k' ? 'dist/prisma/seed-10k.js' : 'dist/prisma/seed.js';

  if (fs.existsSync(jsPath)) {
    console.log(`[DB-INIT] 🌱 Peuplement de la base (${seedType} via ${jsPath})...`);
    return commandRunner.run('node', [jsPath]);
  } else {
    console.log(`[DB-INIT] 🌱 Peuplement de la base (${seedType} via ${tsPath})...`);
    return commandRunner.run('npx', ['tsx', tsPath]);
  }
}

/**
 * Point d'entrée principal pour le K8s Job
 */
export async function runInitialization(options: InitOptions = {}): Promise<void> {
  console.log('====================================================');
  console.log('   🚀 EPSI PAY - JOB D\'INITIALISATION BASE DE DONNÉES');
  console.log('====================================================');

  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('[DB-INIT] ❌ Variable d\'environnement DATABASE_URL manquante.');
    process.exit(1);
  }

  const schemaPath = options.schemaPath || process.env.SCHEMA_PATH || 'prisma/schema.prisma';
  const seedType: 'standard' | '10k' =
    options.seedType || (process.env.SEED_TYPE === '10k' ? '10k' : 'standard');
  const maxRetries = options.maxRetries ?? (process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES, 10) : 12);
  const retryIntervalMs = options.retryIntervalMs ?? 3000;

  // Une seule connexion : le verrou consultatif est lié à la session SQL qui l'a pris
  const url = new URL(databaseUrl);
  url.searchParams.set('connection_limit', '1');
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: url.toString(),
      },
    },
  });

  try {
    const seedMode = options.seedMode ?? resolveSeedMode();

    // 1. Attente de la base de données
    const isReady = await waitForDatabase(prisma, maxRetries, retryIntervalMs);
    if (!isReady) {
      throw new Error(`PostgreSQL n'a pas répondu après ${maxRetries} tentatives.`);
    }

    await withInitLock(prisma, async () => {
      // 2. Migrations
      const deployResult = await deploySchema(prisma, schemaPath);
      if (!deployResult.success) {
        throw new Error(`Échec du déploiement des migrations : ${deployResult.error}`);
      }

      // 3. Peuplement (Seed)
      if (seedMode === 'never') {
        console.log('[DB-INIT] ⏭️ Étape de seed ignorée (SEED_MODE=never).');
        return;
      }
      if (seedMode === 'if-empty' && !(await isDatabaseEmpty(prisma))) {
        console.log('[DB-INIT] ⏭️ Base déjà peuplée : seed ignoré, données conservées (SEED_MODE=if-empty).');
        return;
      }
      if (seedMode === 'reset') {
        console.warn('[DB-INIT] ⚠️ SEED_MODE=reset : toutes les données vont être effacées puis recréées.');
      }

      const seedResult = await seedDatabase(seedType);
      if (!seedResult.success) {
        throw new Error(`Échec du peuplement des données : ${seedResult.error}`);
      }
    });

    console.log('====================================================');
    console.log('   ✅ INITIALISATION BDD TERMINÉE AVEC SUCCÈS');
    console.log('====================================================');
  } catch (error) {
    console.error('[DB-INIT] 💥 Erreur fatale lors de l\'initialisation :', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Exécution directe en CLI
if (require.main === module) {
  runInitialization();
}
