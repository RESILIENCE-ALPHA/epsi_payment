import { 
  PrismaClient, 
  UserRole, 
  UserStatus, 
  WalletStatus, 
  TransactionType, 
  TransactionStatus,
  IncidentType,
  IncidentSeverity,
  IncidentStatus,
  RemediationAction,
  AuditSeverity
} from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database avec les données du scénario RESILIENCE-ALPHA...');

  // Nettoyage complet dans l'ordre pour respecter les contraintes de clés étrangères
  await prisma.auditLog.deleteMany();
  await prisma.remediationLog.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.session.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.blockedIp.deleteMany();
  await prisma.user.deleteMany();

  // 1. Création des utilisateurs
  // Mot de passe pour tous les comptes de test : Password123!
  const defaultPasswordHash = '$2b$10$rRgtBEDisNqePyocJemQqOHChFGO9g7wvO/pEj2QQ0MM53ve/hQXq';

  const alice = await prisma.user.create({
    data: {
      email: 'alice@epsi.fr',
      name: 'Alice Martin',
      passwordHash: defaultPasswordHash,
      role: UserRole.CLIENT,
      status: UserStatus.ACTIVE,
    },
  });

  const bob = await prisma.user.create({
    data: {
      email: 'bob@epsi.fr',
      name: 'Bob Dupont',
      passwordHash: defaultPasswordHash,
      role: UserRole.CLIENT,
      status: UserStatus.ACTIVE,
    },
  });

  const merchant = await prisma.user.create({
    data: {
      email: 'store@merchant.com',
      name: 'Boutique Démo EPSI',
      passwordHash: defaultPasswordHash,
      role: UserRole.MERCHANT,
      status: UserStatus.ACTIVE,
    },
  });

  // Utilisateur système dédié aux paiements tests de validation
  const systemBot = await prisma.user.create({
    data: {
      email: 'system-bot@epsi-pay.internal',
      name: 'Système Test Remédiation',
      passwordHash: defaultPasswordHash,
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    },
  });

  // 2. Création des portefeuilles (Wallets)
  const aliceWallet = await prisma.wallet.create({
    data: {
      userId: alice.id,
      currency: 'EUR',
      balance: 1500.00,
      status: WalletStatus.ACTIVE,
    },
  });

  const bobWallet = await prisma.wallet.create({
    data: {
      userId: bob.id,
      currency: 'EUR',
      balance: 500.00,
      status: WalletStatus.ACTIVE,
    },
  });

  const merchantWallet = await prisma.wallet.create({
    data: {
      userId: merchant.id,
      currency: 'EUR',
      balance: 3250.00,
      status: WalletStatus.ACTIVE,
    },
  });

  const systemWallet = await prisma.wallet.create({
    data: {
      userId: systemBot.id,
      currency: 'EUR',
      balance: 100000.00,
      status: WalletStatus.ACTIVE,
    },
  });

  // 3. Exemple d'une transaction initiale réussie
  const initialTx = await prisma.transaction.create({
    data: {
      reference: 'TX-INIT-001',
      idempotencyKey: 'idemp-init-key-001',
      type: TransactionType.PAYMENT,
      status: TransactionStatus.SUCCESS,
      amount: 49.99,
      currency: 'EUR',
      description: 'Abonnement mensuel démo',
      senderWalletId: aliceWallet.id,
      receiverWalletId: merchantWallet.id,
      clientIp: '192.168.1.50',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
      fraudScore: 0.05,
    },
  });

  // 4. Exemple d'historique d'incident & remédiation (pour le Dashboard de démo)
  const pastIncident = await prisma.incident.create({
    data: {
      incidentType: IncidentType.BRUTE_FORCE_AUTH,
      severity: IncidentSeverity.HIGH,
      status: IncidentStatus.RESOLVED,
      detectedBy: 'MACHINE_LEARNING',
      targetService: 'Auth',
      targetIp: '192.168.1.200', // IP simulée du PC Attaquant
      metricsSnapshot: {
        failedLoginRate: '85 req/sec',
        totalFailedAttempts: 420,
        anomalyConfidence: 0.98,
      },
      resolvedAt: new Date(),
    },
  });

  await prisma.remediationLog.create({
    data: {
      incidentId: pastIncident.id,
      actionTaken: RemediationAction.IP_BLOCK_ENFORCED,
      executedBy: 'AUTO_REMEDIATION_ENGINE',
      isSuccess: true,
      durationMs: 320,
      details: { blockedIp: '192.168.1.200', action: 'Blacklisted in blocked_ips' },
    },
  });

  await prisma.remediationLog.create({
    data: {
      incidentId: pastIncident.id,
      actionTaken: RemediationAction.TEST_PAYMENT_VERIFIED,
      executedBy: 'AUTO_REMEDIATION_ENGINE',
      isSuccess: true,
      durationMs: 145,
      details: { proofTransaction: 'TX-INIT-001', status: 'SUCCESS' },
    },
  });

  // 5. Audit Log initial
  await prisma.auditLog.create({
    data: {
      action: 'SYSTEM_SEEDED',
      severity: AuditSeverity.INFO,
      details: {
        message: 'Base de données initialisée avec les comptes et le scénario de démo.',
      },
    },
  });

  console.log('✅ Seed terminé avec succès !');
  console.log({
    utilisateurs: [alice.email, bob.email, merchant.email, systemBot.email],
    wallets: [aliceWallet.id, bobWallet.id, merchantWallet.id],
    incidentDemo: pastIncident.id,
  });
}

main()
  .catch((e) => {
    console.error('❌ Erreur lors du seed :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
