// Contrats des réponses de la passerelle (voir /docs sur l'API)

export type UserRole = 'CLIENT' | 'MERCHANT' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'LOCKED' | 'SUSPENDED';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface LoginSuccess {
  success: true;
  /** Nom actuel du champ côté auth ; `token` reste accepté (ancien contrat) */
  accessToken?: string;
  token?: string;
  expiresAt: string;
  user: User;
}

export interface Wallet {
  id: string;
  currency: string;
  /** Montant exact en chaîne à 2 décimales (jamais de flottant côté API) */
  balance: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  createdAt: string;
  updatedAt: string;
}

export type TransactionType = 'PAYMENT' | 'TRANSFER' | 'REFUND' | 'VALIDATION_TEST';
export type TransactionStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'BLOCKED';

export interface Payment {
  id: string;
  reference: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: string;
  currency: string;
  description: string | null;
  senderWalletId: string | null;
  receiverWalletId: string;
  createdAt: string;
}

export interface Counterparty {
  name: string | null;
  email: string;
}

/** Transaction vue depuis un portefeuille : sens du mouvement et autre partie */
export interface HistoryEntry extends Payment {
  direction: 'DEBIT' | 'CREDIT';
  counterparty: Counterparty | null;
}

export interface PaymentRequest {
  senderWalletId: string;
  recipientEmail: string;
  amount: string;
  description?: string;
}

/** Corps d'erreur commun aux services ({ error, message }) et champs propres à la connexion */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  service?: string;
  remainingAttempts?: number;
  lockedUntil?: string | null;
}
