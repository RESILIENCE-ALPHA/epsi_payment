import { Prisma } from '@epsi-pay/database';
import { PaymentError } from './errors';

/** Plafond d'un paiement unitaire (garde-fou contre les saisies aberrantes ou malveillantes) */
export const MAX_PAYMENT_AMOUNT = new Prisma.Decimal('10000.00');
export const MAX_DESCRIPTION_LENGTH = 255;
export const MAX_EMAIL_LENGTH = 254;

const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Convertit un montant en Decimal exact (jamais de flottant pour de l'argent).
 * Accepte "12.50" ou 12.5 ; refuse les montants nuls, négatifs, à plus de 2 décimales ou au-delà du plafond.
 */
export function parseAmount(value: unknown): Prisma.Decimal {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string' || !AMOUNT_PATTERN.test(raw)) {
    throw new PaymentError(400, 'INVALID_AMOUNT', 'Le montant doit être un nombre positif avec au plus 2 décimales.');
  }

  const amount = new Prisma.Decimal(raw);
  if (amount.lte(0)) {
    throw new PaymentError(400, 'INVALID_AMOUNT', 'Le montant doit être strictement positif.');
  }
  if (amount.gt(MAX_PAYMENT_AMOUNT)) {
    throw new PaymentError(400, 'AMOUNT_TOO_HIGH', `Le montant ne peut pas dépasser ${MAX_PAYMENT_AMOUNT.toFixed(2)}.`);
  }
  return amount;
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new PaymentError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'En-tête Idempotency-Key requis (8 à 128 caractères : lettres, chiffres, _ . : -).',
    );
  }
  return value;
}

/**
 * Le destinataire est désigné soit par l'id de son portefeuille, soit par son e-mail
 * (cas de l'interface : l'utilisateur ne connaît pas les portefeuilles des autres).
 * Exactement l'un des deux est renseigné.
 */
export interface PaymentInput {
  senderWalletId: string;
  receiverWalletId?: string;
  recipientEmail?: string;
  amount: Prisma.Decimal;
  currency?: string;
  description?: string;
}

export function parsePaymentInput(body: unknown): PaymentInput {
  const { senderWalletId, receiverWalletId, recipientEmail, amount, currency, description } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!isUuid(senderWalletId)) {
    throw new PaymentError(400, 'INVALID_INPUT', 'senderWalletId doit être un UUID.');
  }
  if ((receiverWalletId === undefined) === (recipientEmail === undefined)) {
    throw new PaymentError(400, 'INVALID_INPUT', 'Indiquez le destinataire par receiverWalletId ou par recipientEmail (l\'un des deux).');
  }
  if (receiverWalletId !== undefined && !isUuid(receiverWalletId)) {
    throw new PaymentError(400, 'INVALID_INPUT', 'receiverWalletId doit être un UUID.');
  }
  if (
    recipientEmail !== undefined &&
    (typeof recipientEmail !== 'string' || recipientEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(recipientEmail.trim()))
  ) {
    throw new PaymentError(400, 'INVALID_INPUT', 'recipientEmail doit être une adresse e-mail valide.');
  }
  if (senderWalletId === receiverWalletId) {
    throw new PaymentError(400, 'SAME_WALLET', 'Le portefeuille émetteur et le destinataire doivent être différents.');
  }
  if (currency !== undefined && (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))) {
    throw new PaymentError(400, 'INVALID_INPUT', 'currency doit être un code ISO 4217 (ex: EUR).');
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
    throw new PaymentError(400, 'INVALID_INPUT', `description doit être un texte de ${MAX_DESCRIPTION_LENGTH} caractères maximum.`);
  }

  return {
    senderWalletId,
    receiverWalletId: receiverWalletId as string | undefined,
    // Même normalisation que la connexion (auth) : les e-mails sont stockés en minuscules
    recipientEmail: typeof recipientEmail === 'string' ? recipientEmail.trim().toLowerCase() : undefined,
    amount: parseAmount(amount),
    currency,
    description,
  };
}
