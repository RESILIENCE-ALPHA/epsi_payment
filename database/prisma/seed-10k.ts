import { 
  PrismaClient, 
  UserRole, 
  UserStatus, 
  WalletStatus, 
  TransactionType, 
  TransactionStatus,
  AuditSeverity
} from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function generate10kData() {
  console.log('🚀 Démarrage de la génération haute performance de 10 000+ enregistrements...');
  const startTime = Date.now();

  // 1. Vérification si la base est déjà peuplée
  const existingAttempts = await prisma.loginAttempt.count();
  if (existingAttempts >= 5000) {
    console.log(`ℹ️ La base contient déjà ${existingAttempts} tentatives de connexion. Seed volumétrique ignoré.`);
    return;
  }

  // 2. Nettoyage rapide préalable
  console.log('🧹 Nettoyage des tables existantes...');
  await prisma.auditLog.deleteMany();
  await prisma.remediationLog.deleteMany();
  await prisma.incident.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.session.deleteMany();
  await prisma.loginAttempt.deleteMany();
  await prisma.blockedIp.deleteMany();
  await prisma.user.deleteMany();

  // 3. Génération de 100 utilisateurs avec IDs pré-calculés
  console.log('👥 Génération de 100 utilisateurs et portefeuilles...');
  const userIds: string[] = [];
  const walletIds: string[] = [];
  const usersData = [];
  const walletsData = [];

  const roles = [UserRole.CLIENT, UserRole.CLIENT, UserRole.CLIENT, UserRole.MERCHANT];
  const domainList = ['gmail.com', 'epsi.fr', 'yahoo.fr', 'outlook.com', 'orange.fr'];

  for (let i = 1; i <= 100; i++) {
    const userId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    userIds.push(userId);
    walletIds.push(walletId);

    const role = i <= 5 ? UserRole.MERCHANT : roles[i % roles.length];
    const email = i === 1 ? 'alice@epsi.fr' : i === 2 ? 'bob@epsi.fr' : `user${i}@${domainList[i % domainList.length]}`;
    const name = i === 1 ? 'Alice Martin' : i === 2 ? 'Bob Dupont' : `Client ${i}`;

    usersData.push({
      id: userId,
      email,
      name,
      // Mot de passe pour tous les comptes : Password123!
      passwordHash: '$2b$10$rRgtBEDisNqePyocJemQqOHChFGO9g7wvO/pEj2QQ0MM53ve/hQXq',
      role,
      status: UserStatus.ACTIVE,
      failedLoginAttempts: 0,
      createdAt: new Date(Date.now() - Math.floor(Math.random() * 30 * 86400000)),
    });

    walletsData.push({
      id: walletId,
      userId,
      currency: 'EUR',
      balance: Math.floor(Math.random() * 5000) + 100.50,
      status: WalletStatus.ACTIVE,
      version: 0,
    });
  }

  await prisma.user.createMany({ data: usersData });
  await prisma.wallet.createMany({ data: walletsData });

  // 4. Génération de 7 000 tentatives de connexion (pour alimenter le Machine Learning)
  console.log('🛡️ Génération de 7 000 logs de connexion (Trafic normal + Attaque Brute Force)...');
  const loginAttemptsData = [];
  const legitimateIps = [
    '82.64.12.34', '90.85.45.12', '176.132.89.5', '194.254.60.10',
    '86.200.14.78', '92.154.33.90', '77.128.56.21', '80.12.43.19'
  ];
  const userAgentsLegit = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    'Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/121.0'
  ];

  const attackerIp = '192.168.1.200'; // IP ciblée du PC Attaquant dans le workshop
  const attackerUserAgents = [
    'Hydra/9.5 (https://github.com/vanhauser-thc/thc-hydra)',
    'Python-urllib/3.10',
    'curl/8.4.0',
    'Wfuzz/3.1.0'
  ];

  const now = Date.now();

  // 6 000 connexions normales réparties sur les 7 derniers jours
  for (let i = 0; i < 6000; i++) {
    const isSuccess = Math.random() > 0.08; // 92% de succès
    const randomUser = usersData[Math.floor(Math.random() * usersData.length)];
    const ip = legitimateIps[Math.floor(Math.random() * legitimateIps.length)];
    const userAgent = userAgentsLegit[Math.floor(Math.random() * userAgentsLegit.length)];
    const timestamp = new Date(now - Math.floor(Math.random() * 7 * 86400000));

    loginAttemptsData.push({
      attemptedEmail: randomUser.email,
      targetUserId: isSuccess ? randomUser.id : null,
      ipAddress: ip,
      userAgent,
      isAuthenticated: isSuccess,
      failureReason: isSuccess ? null : 'INVALID_CREDENTIALS',
      createdAt: timestamp,
    });
  }

  // 1 000 tentatives d'attaque Brute Force concentrées dans les dernières minutes (Pattern d'anomalie ML)
  for (let i = 0; i < 1000; i++) {
    const targetEmail = usersData[i % 5].email; // Attaque ciblée sur les premiers comptes
    const userAgent = attackerUserAgents[i % attackerUserAgents.length];
    // Rafale concentrée sur les 10 dernières minutes
    const attackTimestamp = new Date(now - Math.floor(Math.random() * 600000));

    loginAttemptsData.push({
      attemptedEmail: targetEmail,
      targetUserId: usersData[i % 5].id, // Ici l'attaquant cible un compte existant
      ipAddress: attackerIp,
      userAgent,
      isAuthenticated: false,
      failureReason: 'INVALID_CREDENTIALS',
      createdAt: attackTimestamp,
    });
  }

  // Insertion en lots pour vitesse maximale
  await prisma.loginAttempt.createMany({ data: loginAttemptsData });

  // 5. Génération de 2 500 transactions financières
  console.log('💳 Génération de 2 500 transactions financières...');
  const transactionsData = [];
  const merchantWalletIds = walletIds.slice(0, 5);
  const clientWalletIds = walletIds.slice(5);

  for (let i = 1; i <= 2500; i++) {
    const isFraud = Math.random() < 0.03; // 3% de transactions suspectes
    const sender = clientWalletIds[Math.floor(Math.random() * clientWalletIds.length)];
    const receiver = merchantWalletIds[Math.floor(Math.random() * merchantWalletIds.length)];
    const amount = isFraud ? (Math.floor(Math.random() * 4000) + 1500) : (Math.floor(Math.random() * 200) + 5.50);
    const status = isFraud ? TransactionStatus.BLOCKED : TransactionStatus.SUCCESS;
    const fraudScore = isFraud ? (0.85 + Math.random() * 0.14) : (Math.random() * 0.15);
    const fraudReason = isFraud ? 'ANOMALY_HIGH_AMOUNT_SUSPICIOUS_VELOCITY' : null;

    transactionsData.push({
      reference: `TX-${100000 + i}`,
      idempotencyKey: `idemp-key-${crypto.randomUUID()}`,
      type: TransactionType.PAYMENT,
      status,
      amount,
      currency: 'EUR',
      description: `Achat boutique #${(i % 50) + 1}`,
      senderWalletId: sender,
      receiverWalletId: receiver,
      clientIp: isFraud ? attackerIp : legitimateIps[i % legitimateIps.length],
      userAgent: userAgentsLegit[i % userAgentsLegit.length],
      fraudScore,
      fraudReason,
      createdAt: new Date(now - Math.floor(Math.random() * 7 * 86400000)),
    });
  }

  await prisma.transaction.createMany({ data: transactionsData });

  // 6. Génération de 500 logs d'audit (NIS2 / DORA)
  console.log('📜 Génération de 500 logs d\'audit de sécurité...');
  const auditLogsData = [];
  const auditActions = [
    { action: 'USER_LOGIN_SUCCESS', severity: AuditSeverity.INFO },
    { action: 'TRANSACTION_AUTHORIZED', severity: AuditSeverity.INFO },
    { action: 'LOGIN_FAILURE_THRESHOLD_EXCEEDED', severity: AuditSeverity.WARNING },
    { action: 'BRUTE_FORCE_PATTERN_FLAGGED', severity: AuditSeverity.CRITICAL },
    { action: 'IP_TEMPORARY_BLOCK', severity: AuditSeverity.WARNING },
  ];

  for (let i = 0; i < 500; i++) {
    const item = auditActions[Math.floor(Math.random() * auditActions.length)];
    auditLogsData.push({
      userId: userIds[Math.floor(Math.random() * userIds.length)],
      action: item.action,
      severity: item.severity,
      details: {
        event: item.action,
        code: 200 + (i % 50),
        source: 'epsi_pay_security_filter',
      },
      ipAddress: legitimateIps[i % legitimateIps.length],
      createdAt: new Date(now - Math.floor(Math.random() * 7 * 86400000)),
    });
  }

  await prisma.auditLog.createMany({ data: auditLogsData });

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  const totalCount = usersData.length + walletsData.length + loginAttemptsData.length + transactionsData.length + auditLogsData.length;

  console.log(`\n🎉 SUCCÈS ! ${totalCount} entrées générées en ${totalTime} secondes !`);
  console.log(`   - Utilisateurs : ${usersData.length}`);
  console.log(`   - Portefeuilles : ${walletsData.length}`);
  console.log(`   - Tentatives de connexion (ML) : ${loginAttemptsData.length} (dont 1 000 brute force)`);
  console.log(`   - Transactions : ${transactionsData.length} (dont fraudes étiquetées)`);
  console.log(`   - Audit logs (NIS2/DORA) : ${auditLogsData.length}`);
}

generate10kData()
  .catch((e) => {
    console.error('❌ Erreur lors de la génération volumétrique :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
