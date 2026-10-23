import crypto from 'crypto';
import {
  prisma,
  Prisma,
  Transaction,
  Wallet,
  TransactionType,
  TransactionStatus,
  WalletStatus,
  AuditSeverity,
  RemediationAction,
} from '@epsi-pay/database';
import { checkIpBlocked } from '@epsi-pay/auth';
import { PaymentError } from './errors';
import { PaymentInput } from './validation';

/** Nombre de tentatives en cas de conflit d'écriture (deadlock ou sérialisation détectés par PostgreSQL) */
export const MAX_WRITE_ATTEMPTS = 3;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

export const VALIDATION_AMOUNT = new Prisma.Decimal('0.01');

// ---------------------------------------------------------------
// Sérialisation : les montants sortent en chaîne à 2 décimales (pas de flottant côté client)
// ---------------------------------------------------------------

export function toWalletView(wallet: Wallet) {
  return {
    id: wallet.id,
    currency: wallet.currency,
    balance: wallet.balance.toFixed(2),
    status: wallet.status,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toTransactionView(transaction: Transaction) {
  return {
    id: transaction.id,
    reference: transaction.reference,
    type: transaction.type,
    status: transaction.status,
    amount: transaction.amount.toFixed(2),
    currency: transaction.currency,
    description: transaction.description,
    senderWalletId: transaction.senderWalletId,
    receiverWalletId: transaction.receiverWalletId,
    createdAt: transaction.createdAt,
  };
}

const COUNTERPARTY_INCLUDE = {
  senderWallet: { select: { userId: true, user: { select: { name: true, email: true } } } },
  receiverWallet: { select: { userId: true, user: { select: { name: true, email: true } } } },
} satisfies Prisma.TransactionInclude;

export type TransactionWithParties = Prisma.TransactionGetPayload<{ include: typeof COUNTERPARTY_INCLUDE }>;

/**
 * Ligne d'historique vue depuis un portefeuille : sens du mouvement et identité de l'autre partie,
 * pour que l'interface affiche « Bob · −12,50 » plutôt que deux UUID.
 */
export function toHistoryEntryView(transaction: TransactionWithParties, walletId: string) {
  const outgoing = transaction.senderWalletId === walletId;
  const other = outgoing ? transaction.receiverWallet : transaction.senderWallet;
  return {
    ...toTransactionView(transaction),
    direction: outgoing ? 'DEBIT' : 'CREDIT',
    counterparty: other ? { name: other.user.name, email: other.user.email } : null,
  };
}

// ---------------------------------------------------------------
// Consultation
// ---------------------------------------------------------------

export async function listWallets(userId: string): Promise<Wallet[]> {
  return prisma.wallet.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Portefeuille de l'utilisateur et ses dernières transactions.
 * Un portefeuille d'un autre utilisateur répond 404 (on ne confirme pas son existence).
 */
export async function getWalletWithHistory(userId: string, walletId: string, limit: number) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.userId !== userId) {
    throw new PaymentError(404, 'WALLET_NOT_FOUND', 'Portefeuille introuvable.');
  }

  const transactions = await prisma.transaction.findMany({
    where: { OR: [{ senderWalletId: walletId }, { receiverWalletId: walletId }] },
    include: COUNTERPARTY_INCLUDE,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return { wallet, transactions };
}

export async function getPayment(userId: string, transactionId: string): Promise<Transaction> {
  const transaction = await prisma.transaction.findFirst({
    where: {
      id: transactionId,
      OR: [{ senderWallet: { userId } }, { receiverWallet: { userId } }],
    },
  });
  if (!transaction) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Paiement introuvable.');
  }
  return transaction;
}

// ---------------------------------------------------------------
// Exécution d'un paiement
// ---------------------------------------------------------------

export interface ExecutePaymentParams extends PaymentInput {
  userId: string;
  idempotencyKey: string;
  clientIp?: string;
  userAgent?: string;
  type?: TransactionType;
}

/** Paramètres après résolution du destinataire : le portefeuille cible est connu */
type ResolvedPaymentParams = ExecutePaymentParams & { receiverWalletId: string };

export interface PaymentResult {
  transaction: Transaction;
  /** Vrai si la requête rejoue une clé d'idempotence déjà traitée (aucun nouveau débit) */
  replayed: boolean;
}

/** Filet de sécurité : le débit conditionnel n'a touché aucune ligne alors que les verrous sont posés */
class ConcurrentUpdateError extends Error {}

function isRetryableWriteConflict(error: unknown): boolean {
  if (error instanceof ConcurrentUpdateError) return true;
  // P2034 : conflit d'écriture ou deadlock détecté par PostgreSQL
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function isIdempotencyKeyConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    JSON.stringify(error.meta?.target ?? '').includes('idempotencyKey')
  );
}

/**
 * La clé est cloisonnée par utilisateur : deux clients peuvent choisir la même clé
 * sans collision ni fuite d'information sur les paiements d'autrui.
 */
function scopedIdempotencyKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

/** Rejoue un paiement déjà traité, à condition que la requête soit strictement identique */
async function findReplay(params: ResolvedPaymentParams, storedKey: string): Promise<Transaction | null> {
  const existing = await prisma.transaction.findUnique({ where: { idempotencyKey: storedKey } });
  if (!existing) return null;

  const samePayload =
    existing.senderWalletId === params.senderWalletId &&
    existing.receiverWalletId === params.receiverWalletId &&
    existing.amount.equals(params.amount);

  if (!samePayload) {
    throw new PaymentError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      'Cette clé d\'idempotence a déjà été utilisée pour un paiement différent.',
    );
  }
  return existing;
}

async function recordRejection(params: ExecutePaymentParams, error: PaymentError): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: 'PAYMENT_REJECTED',
        severity: error.code === 'IP_BLOCKED' ? AuditSeverity.CRITICAL : AuditSeverity.WARNING,
        ipAddress: params.clientIp,
        details: {
          reason: error.code,
          senderWalletId: params.senderWalletId,
          receiverWalletId: params.receiverWalletId,
          recipientEmail: params.recipientEmail,
          amount: params.amount.toFixed(2),
        },
      },
    });
  } catch (auditError) {
    // L'audit ne doit jamais masquer la vraie réponse au client
    console.error('[PAYMENT] Audit log write failed:', auditError);
  }
}

/**
 * Trouve le portefeuille actif du destinataire dans la devise du portefeuille émetteur.
 * Destinataire inconnu, sans portefeuille compatible ou égal à l'émetteur : même 404 générique.
 */
async function resolveRecipientWallet(params: ExecutePaymentParams): Promise<string> {
  const sender = await prisma.wallet.findUnique({ where: { id: params.senderWalletId } });
  if (!sender || sender.userId !== params.userId) {
    throw new PaymentError(404, 'WALLET_NOT_FOUND', 'Portefeuille émetteur introuvable.');
  }

  const recipient = await prisma.wallet.findFirst({
    where: {
      user: { email: params.recipientEmail },
      currency: sender.currency,
      status: WalletStatus.ACTIVE,
      id: { not: sender.id },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!recipient) {
    throw new PaymentError(404, 'RECEIVER_NOT_FOUND', 'Aucun destinataire actif avec cette adresse e-mail dans cette devise.');
  }
  return recipient.id;
}

/**
 * Débite l'émetteur et crédite le destinataire dans une transaction SQL unique.
 *
 * Garanties :
 * - destinataire par e-mail : résolu après le contrôle d'IP (une IP bloquée ne peut pas sonder les comptes) ;
 * - idempotence : une même Idempotency-Key ne débite qu'une fois (rejeu → même transaction) ;
 * - verrou pessimiste (SELECT … FOR UPDATE) sur les deux portefeuilles, posé par ordre d'id :
 *   les paiements concurrents sur un même portefeuille sont sérialisés au lieu d'échouer,
 *   et l'ordre fixe évite les deadlocks entre virements croisés A→B / B→A ;
 * - pas de découvert : solde vérifié sous verrou, puis débit conditionnel `balance >= montant` ;
 * - `version` incrémentée à chaque écriture pour les lecteurs en verrouillage optimiste.
 */
export async function executePayment(input: ExecutePaymentParams): Promise<PaymentResult> {
  const storedKey = scopedIdempotencyKey(input.userId, input.idempotencyKey);
  let params = input;

  try {
    if (input.clientIp) {
      const { isBlocked } = await checkIpBlocked(input.clientIp);
      if (isBlocked) {
        throw new PaymentError(403, 'IP_BLOCKED', 'Votre adresse IP a été bloquée suite à une activité suspecte.');
      }
    }

    const resolved: ResolvedPaymentParams = {
      ...input,
      receiverWalletId: input.receiverWalletId ?? (await resolveRecipientWallet(input)),
    };
    params = resolved;

    const replay = await findReplay(resolved, storedKey);
    if (replay) return { transaction: replay, replayed: true };

    for (let attempt = 1; ; attempt++) {
      try {
        const transaction = await prisma.$transaction((tx) => transfer(tx, resolved, storedKey));
        return { transaction, replayed: false };
      } catch (error) {
        if (isRetryableWriteConflict(error) && attempt < MAX_WRITE_ATTEMPTS) continue;
        if (isRetryableWriteConflict(error)) {
          throw new PaymentError(409, 'CONCURRENT_UPDATE', 'Le portefeuille est en cours de modification, réessayez.');
        }
        throw error;
      }
    }
  } catch (error) {
    // Deux requêtes simultanées avec la même clé : la seconde rejoue la première
    if (isIdempotencyKeyConflict(error) && params.receiverWalletId) {
      const replay = await findReplay(params as ResolvedPaymentParams, storedKey);
      if (replay) return { transaction: replay, replayed: true };
    }
    if (error instanceof PaymentError) await recordRejection(params, error);
    throw error;
  }
}

async function transfer(
  tx: Prisma.TransactionClient,
  params: ResolvedPaymentParams,
  storedKey: string,
): Promise<Transaction> {
  const { userId, senderWalletId, receiverWalletId, amount } = params;

  // Verrouille les lignes jusqu'au COMMIT ; les lectures suivantes voient l'état le plus récent
  await tx.$queryRaw`SELECT id FROM wallets WHERE id IN (${senderWalletId}, ${receiverWalletId}) ORDER BY id FOR UPDATE`;

  const sender = await tx.wallet.findUnique({ where: { id: senderWalletId } });
  if (!sender || sender.userId !== userId) {
    throw new PaymentError(404, 'WALLET_NOT_FOUND', 'Portefeuille émetteur introuvable.');
  }
  if (sender.status !== WalletStatus.ACTIVE) {
    throw new PaymentError(422, 'WALLET_NOT_ACTIVE', 'Le portefeuille émetteur n\'est pas actif.');
  }
  if (params.currency && params.currency !== sender.currency) {
    throw new PaymentError(422, 'CURRENCY_MISMATCH', `Le portefeuille émetteur est en ${sender.currency}.`);
  }

  const receiver = await tx.wallet.findUnique({ where: { id: receiverWalletId } });
  if (!receiver || receiver.status !== WalletStatus.ACTIVE) {
    throw new PaymentError(404, 'RECEIVER_NOT_FOUND', 'Portefeuille destinataire introuvable ou inactif.');
  }
  if (receiver.currency !== sender.currency) {
    throw new PaymentError(422, 'CURRENCY_MISMATCH', 'Les deux portefeuilles doivent être dans la même devise.');
  }
  if (sender.balance.lessThan(amount)) {
    throw new PaymentError(422, 'INSUFFICIENT_FUNDS', 'Solde insuffisant.');
  }

  const debit = await tx.wallet.updateMany({
    where: { id: sender.id, balance: { gte: amount } },
    data: { balance: { decrement: amount }, version: { increment: 1 } },
  });
  if (debit.count === 0) throw new ConcurrentUpdateError();

  await tx.wallet.update({
    where: { id: receiver.id },
    data: { balance: { increment: amount }, version: { increment: 1 } },
  });

  const transaction = await tx.transaction.create({
    data: {
      idempotencyKey: storedKey,
      type: params.type ?? TransactionType.PAYMENT,
      status: TransactionStatus.SUCCESS,
      amount,
      currency: sender.currency,
      description: params.description,
      senderWalletId: sender.id,
      receiverWalletId: receiver.id,
      clientIp: params.clientIp,
      userAgent: params.userAgent,
    },
  });

  await tx.auditLog.create({
    data: {
      userId,
      transactionId: transaction.id,
      action: transaction.type === TransactionType.VALIDATION_TEST ? 'VALIDATION_PAYMENT_SUCCESS' : 'PAYMENT_SUCCESS',
      severity: AuditSeverity.INFO,
      ipAddress: params.clientIp,
      details: { reference: transaction.reference, amount: amount.toFixed(2), currency: sender.currency },
    },
  });

  return transaction;
}

// ---------------------------------------------------------------
// Paiement de validation post-incident ("ça remarche ?")
// ---------------------------------------------------------------

export interface ValidationResult {
  success: boolean;
  durationMs: number;
  transaction?: Transaction;
  error?: string;
}

async function findActiveWalletByEmail(email: string): Promise<Wallet> {
  const wallet = await prisma.wallet.findFirst({
    where: { user: { email }, status: WalletStatus.ACTIVE },
    orderBy: { createdAt: 'asc' },
  });
  if (!wallet) {
    throw new PaymentError(503, 'VALIDATION_WALLET_MISSING', `Aucun portefeuille actif pour ${email}.`);
  }
  return wallet;
}

/**
 * Émet un vrai paiement VALIDATION_TEST de 0,01 entre deux comptes dédiés, par le même chemin
 * qu'un paiement client (transaction SQL, verrouillage, audit). Appelé par le moteur de remédiation
 * après un incident : si le paiement passe, la plateforme est rétablie.
 *
 * Avec un incidentId, la preuve (succès/échec + durée) est inscrite dans remediation_logs.
 */
export async function runValidationPayment(incidentId?: string): Promise<ValidationResult> {
  const startedAt = Date.now();
  let result: ValidationResult;

  try {
    const sender = await findActiveWalletByEmail(process.env.VALIDATION_SENDER_EMAIL ?? 'system-bot@epsi-pay.internal');
    const receiver = await findActiveWalletByEmail(process.env.VALIDATION_RECEIVER_EMAIL ?? 'store@merchant.com');

    const { transaction } = await executePayment({
      userId: sender.userId,
      senderWalletId: sender.id,
      receiverWalletId: receiver.id,
      amount: VALIDATION_AMOUNT,
      description: incidentId ? `Validation post-incident ${incidentId}` : 'Validation de bon fonctionnement',
      idempotencyKey: `validation-${crypto.randomUUID()}`,
      type: TransactionType.VALIDATION_TEST,
    });
    result = { success: true, durationMs: Date.now() - startedAt, transaction };
  } catch (error) {
    const code = error instanceof PaymentError ? error.code : 'VALIDATION_PAYMENT_FAILED';
    console.error('[PAYMENT] Validation payment failed:', error);
    result = { success: false, durationMs: Date.now() - startedAt, error: code };
  }

  if (incidentId) {
    await recordRemediationProof(incidentId, result);
  }
  return result;
}

async function recordRemediationProof(incidentId: string, result: ValidationResult): Promise<void> {
  try {
    await prisma.remediationLog.create({
      data: {
        incidentId,
        actionTaken: RemediationAction.TEST_PAYMENT_VERIFIED,
        executedBy: 'PAYMENT_SERVICE',
        isSuccess: result.success,
        durationMs: result.durationMs,
        details: result.transaction
          ? { transactionId: result.transaction.id, reference: result.transaction.reference }
          : { error: result.error ?? 'UNKNOWN' },
      },
    });
  } catch (error) {
    console.error(`[PAYMENT] Unable to record remediation proof for incident ${incidentId}:`, error);
  }
}
