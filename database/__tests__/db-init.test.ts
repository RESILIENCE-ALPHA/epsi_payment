import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  waitForDatabase,
  seedDatabase,
  deploySchema,
  resolveSeedMode,
  isDatabaseEmpty,
  withInitLock,
  commandRunner,
  BASELINE_MIGRATION,
} from '../init';

describe('Database Init & Migration Service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('waitForDatabase (Sonde de résilience & Retry)', () => {
    it('doit réussir immédiatement si la base de données répond au premier essai', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockResolvedValueOnce([{ '?column?': 1 }]),
      } as any;

      const ready = await waitForDatabase(mockPrisma, 3, 10);

      expect(ready).toBe(true);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('doit réitérer et réussir si PostgreSQL devient accessible après plusieurs tentatives', async () => {
      const mockPrisma = {
        $queryRaw: vi
          .fn()
          .mockRejectedValueOnce(new Error('Connection refused'))
          .mockRejectedValueOnce(new Error('PostgreSQL starting up'))
          .mockResolvedValueOnce([{ '?column?': 1 }]),
      } as any;

      const ready = await waitForDatabase(mockPrisma, 4, 10);

      expect(ready).toBe(true);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(3);
    });

    it('doit renvoyer false si PostgreSQL reste inaccessible au-delà du nombre maximal de tentatives', async () => {
      const mockPrisma = {
        $queryRaw: vi.fn().mockRejectedValue(new Error('Host unreachable')),
      } as any;

      const ready = await waitForDatabase(mockPrisma, 3, 5);

      expect(ready).toBe(false);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(3);
    });
  });

  describe('deploySchema & seedDatabase (Orchestration)', () => {
    // Simule to_regclass() : liste des tables présentes dans la base
    const mockDatabase = (tables: string[]) =>
      ({
        $queryRaw: vi.fn((_sql: TemplateStringsArray, table: string) =>
          Promise.resolve([{ exists: tables.includes(table) }]),
        ),
      }) as any;

    it('doit appliquer les migrations avec prisma migrate deploy sur une base neuve', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValue({ success: true, output: 'ok' });

      const result = await deploySchema(mockDatabase([]), 'prisma/schema.prisma');

      expect(result.success).toBe(true);
      expect(spyRun).toHaveBeenCalledTimes(1);
      expect(spyRun).toHaveBeenCalledWith('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma']);
    });

    it('doit rattacher une base créée par db push à la migration initiale avant le deploy', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValue({ success: true, output: 'ok' });

      await deploySchema(mockDatabase(['users']), 'prisma/schema.prisma');

      expect(spyRun).toHaveBeenNthCalledWith(1, 'npx', [
        'prisma',
        'migrate',
        'resolve',
        '--applied',
        BASELINE_MIGRATION,
        '--schema=prisma/schema.prisma',
      ]);
      expect(spyRun).toHaveBeenNthCalledWith(2, 'npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma']);
    });

    it('ne doit pas rattacher une base qui possède déjà un historique de migrations', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValue({ success: true, output: 'ok' });

      await deploySchema(mockDatabase(['users', '_prisma_migrations']), 'prisma/schema.prisma');

      expect(spyRun).toHaveBeenCalledTimes(1);
      expect(spyRun.mock.calls[0][1]).toContain('deploy');
    });

    it('ne doit jamais utiliser db push --accept-data-loss', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValue({ success: true, output: 'ok' });

      await deploySchema(mockDatabase(['users']));

      const allArgs = spyRun.mock.calls.flatMap(([, args]) => args);
      expect(allArgs).not.toContain('push');
      expect(allArgs).not.toContain('--accept-data-loss');
    });

    it('doit interrompre le déploiement si le rattachement échoue', async () => {
      const spyRun = vi
        .spyOn(commandRunner, 'run')
        .mockResolvedValueOnce({ success: false, output: '', error: 'P3008' });

      const result = await deploySchema(mockDatabase(['users']));

      expect(result.success).toBe(false);
      expect(spyRun).toHaveBeenCalledTimes(1);
    });

    it('doit cibler le script seed-10k lorsque seedType vaut "10k"', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValueOnce({
        success: true,
        output: 'Seed completed successfully.',
      });

      const result = await seedDatabase('10k');

      expect(result.success).toBe(true);
      expect(spyRun).toHaveBeenCalled();
      const [cmd, args] = spyRun.mock.calls[0];
      expect(['node', 'npx']).toContain(cmd);
      expect(args.some((arg: string) => arg.includes('seed-10k'))).toBe(true);
    });

    it('doit cibler le script seed standard lorsque seedType vaut "standard"', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValueOnce({
        success: true,
        output: 'Standard seed completed.',
      });

      const result = await seedDatabase('standard');

      expect(result.success).toBe(true);
      expect(spyRun).toHaveBeenCalled();
      const [cmd, args] = spyRun.mock.calls[0];
      expect(['node', 'npx']).toContain(cmd);
      expect(args.some((arg: string) => arg.includes('seed.'))).toBe(true);
    });

    it('doit cibler le script seed standard par défaut lorsque aucun paramètre n\'est fourni', async () => {
      const spyRun = vi.spyOn(commandRunner, 'run').mockResolvedValueOnce({
        success: true,
        output: 'Standard seed completed by default.',
      });

      const result = await seedDatabase();

      expect(result.success).toBe(true);
      expect(spyRun).toHaveBeenCalled();
      const [cmd, args] = spyRun.mock.calls[0];
      expect(['node', 'npx']).toContain(cmd);
      expect(args.some((arg: string) => arg.includes('seed.'))).toBe(true);
    });
  });

  describe('resolveSeedMode (protection des données)', () => {
    it('doit valoir if-empty par défaut', () => {
      expect(resolveSeedMode({})).toBe('if-empty');
    });

    it('doit respecter SEED_MODE et l\'ancienne variable SKIP_SEED', () => {
      expect(resolveSeedMode({ SEED_MODE: 'never' })).toBe('never');
      expect(resolveSeedMode({ SEED_MODE: 'reset' })).toBe('reset');
      expect(resolveSeedMode({ SKIP_SEED: 'true', SEED_MODE: 'reset' })).toBe('never');
    });

    it('doit refuser un SEED_MODE inconnu', () => {
      expect(() => resolveSeedMode({ SEED_MODE: 'always' })).toThrow(/SEED_MODE invalide/);
    });

    it('doit refuser SEED_MODE=reset en production sans ALLOW_DATA_RESET=true', () => {
      expect(() => resolveSeedMode({ SEED_MODE: 'reset', NODE_ENV: 'production' })).toThrow(/ALLOW_DATA_RESET/);
      expect(resolveSeedMode({ SEED_MODE: 'reset', NODE_ENV: 'production', ALLOW_DATA_RESET: 'true' })).toBe('reset');
    });
  });

  describe('isDatabaseEmpty & withInitLock', () => {
    it('doit considérer la base vide uniquement sans aucun utilisateur', async () => {
      expect(await isDatabaseEmpty({ user: { count: vi.fn().mockResolvedValue(0) } } as any)).toBe(true);
      expect(await isDatabaseEmpty({ user: { count: vi.fn().mockResolvedValue(4) } } as any)).toBe(false);
    });

    it('doit libérer le verrou même si l\'initialisation échoue', async () => {
      const client = { $executeRaw: vi.fn().mockResolvedValue(1) } as any;

      await expect(withInitLock(client, async () => { throw new Error('boom'); })).rejects.toThrow('boom');

      expect(client.$executeRaw).toHaveBeenCalledTimes(2);
      expect(String(client.$executeRaw.mock.calls[1][0].join(''))).toContain('pg_advisory_unlock');
    });
  });
});
