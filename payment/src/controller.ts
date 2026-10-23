import { Request, Response } from 'express';
import { prisma } from '@epsi-pay/database';
import { AuthenticatedRequest, extractClientIp } from '@epsi-pay/auth';
import { PaymentError } from './errors';
import { isUuid, parseIdempotencyKey, parsePaymentInput } from './validation';
import {
  DEFAULT_HISTORY_LIMIT,
  MAX_HISTORY_LIMIT,
  executePayment,
  getPayment,
  getWalletWithHistory,
  listWallets,
  runValidationPayment,
  toHistoryEntryView,
  toTransactionView,
  toWalletView,
} from './service';

// Les routes passent par requireAuth : req.user est garanti
function currentUserId(req: AuthenticatedRequest): string {
  return req.user!.id;
}

function parseLimit(value: unknown): number {
  const limit = typeof value === 'string' ? parseInt(value, 10) : DEFAULT_HISTORY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_HISTORY_LIMIT;
  return Math.min(limit, MAX_HISTORY_LIMIT);
}

/**
 * Endpoint GET /wallets
 */
export async function listWalletsHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const wallets = await listWallets(currentUserId(req));
  res.status(200).json({ wallets: wallets.map(toWalletView) });
}

/**
 * Endpoint GET /wallets/:id
 */
export async function getWalletHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const walletId = req.params.id;
  if (!isUuid(walletId)) {
    throw new PaymentError(404, 'WALLET_NOT_FOUND', 'Portefeuille introuvable.');
  }

  const { wallet, transactions } = await getWalletWithHistory(currentUserId(req), walletId, parseLimit(req.query.limit));
  res.status(200).json({
    wallet: toWalletView(wallet),
    transactions: transactions.map((transaction) => toHistoryEntryView(transaction, wallet.id)),
  });
}

/**
 * Endpoint POST /payments
 */
export async function createPaymentHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const idempotencyKey = parseIdempotencyKey(req.headers['idempotency-key']);
  const input = parsePaymentInput(req.body);

  const { transaction, replayed } = await executePayment({
    ...input,
    userId: currentUserId(req),
    idempotencyKey,
    clientIp: extractClientIp(req),
    userAgent: req.headers['user-agent'],
  });

  if (replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(replayed ? 200 : 201).json({ payment: toTransactionView(transaction) });
}

/**
 * Endpoint GET /payments/:id
 */
export async function getPaymentHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  const paymentId = req.params.id;
  if (!isUuid(paymentId)) {
    throw new PaymentError(404, 'PAYMENT_NOT_FOUND', 'Paiement introuvable.');
  }

  const transaction = await getPayment(currentUserId(req), paymentId);
  res.status(200).json({ payment: toTransactionView(transaction) });
}

/**
 * Endpoint interne POST /payments/test-validation
 */
export async function testValidationHandler(req: Request, res: Response): Promise<void> {
  const { incidentId } = (req.body ?? {}) as { incidentId?: unknown };

  if (incidentId !== undefined) {
    const incident = isUuid(incidentId) ? await prisma.incident.findUnique({ where: { id: incidentId } }) : null;
    if (!incident) {
      throw new PaymentError(404, 'INCIDENT_NOT_FOUND', 'Incident introuvable.');
    }
  }

  const result = await runValidationPayment(incidentId as string | undefined);
  res.status(result.success ? 200 : 503).json({
    status: result.success ? 'SUCCESS' : 'FAILED',
    durationMs: result.durationMs,
    ...(result.transaction ? { payment: toTransactionView(result.transaction) } : {}),
    ...(result.error ? { error: result.error } : {}),
  });
}
