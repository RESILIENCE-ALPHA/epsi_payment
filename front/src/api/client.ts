import { getToken } from './session';
import { reportService, type ServiceName } from './serviceStatus';
import type {
  ApiErrorBody,
  HistoryEntry,
  LoginSuccess,
  Payment,
  PaymentRequest,
  User,
  Wallet,
} from './types';

/** Préfixe relayé vers la passerelle par nginx (image) ou par le proxy Vite (dev) */
const API_BASE = '/api';
const REQUEST_TIMEOUT_MS = 15_000;

/** Statuts signifiant « service momentanément indisponible » (passerelle ou nginx devant elle) */
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
const SERVICES: ServiceName[] = ['auth', 'payment', 'api'];

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: ApiErrorBody = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Panne ou délai dépassé : la requête a pu ne pas aboutir, un nouvel essai est pertinent */
  get isUnavailable(): boolean {
    return this.status === 0 || UNAVAILABLE_STATUSES.has(this.status);
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** Notifié quand une requête authentifiée reçoit 401 (session expirée ou révoquée) */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  /** Service cible, pour le bandeau d'incident */
  service: ServiceName;
  /** Envoie le jeton de session (défaut : oui) */
  auth?: boolean;
}

async function request<T>(path: string, { method = 'GET', body, headers = {}, service, auth = true }: RequestOptions): Promise<T> {
  const token = auth ? getToken() : null;
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Réseau coupé, passerelle injoignable ou délai dépassé : aucune réponse exploitable
    reportService('api', 'down');
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    throw new ApiError(
      0,
      timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      timeout ? 'Le serveur met trop de temps à répondre.' : 'Impossible de joindre EPSI Pay.',
    );
  }

  const payload = (await response.json().catch(() => ({}))) as ApiErrorBody & T;

  if (UNAVAILABLE_STATUSES.has(response.status)) {
    // La passerelle précise le service en panne ; sans précision (nginx), c'est la cible appelée
    const failed = SERVICES.includes(payload.service as ServiceName) ? (payload.service as ServiceName) : service;
    reportService(failed, 'down');
  } else {
    reportService(service, 'up');
  }

  if (!response.ok) {
    if (response.status === 401 && token) unauthorizedListeners.forEach((listener) => listener());
    throw new ApiError(
      response.status,
      payload.error ?? `HTTP_${response.status}`,
      payload.message ?? 'Une erreur inattendue est survenue.',
      payload,
    );
  }

  return payload;
}

/** Clé d'idempotence d'un paiement : générée une fois par paiement, réutilisée à chaque nouvel essai */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginSuccess>('/auth/login', { method: 'POST', body: { email, password }, service: 'auth', auth: false }),

  logout: () => request<{ message: string }>('/auth/logout', { method: 'POST', service: 'auth' }),

  me: () => request<{ user: User }>('/auth/me', { service: 'auth' }),

  listWallets: () => request<{ wallets: Wallet[] }>('/wallets', { service: 'payment' }),

  getWallet: (walletId: string, limit = 20) =>
    request<{ wallet: Wallet; transactions: HistoryEntry[] }>(
      `/wallets/${encodeURIComponent(walletId)}?limit=${limit}`,
      { service: 'payment' },
    ),

  createPayment: (payment: PaymentRequest, idempotencyKey: string) =>
    request<{ payment: Payment }>('/payments', {
      method: 'POST',
      body: payment,
      headers: { 'Idempotency-Key': idempotencyKey },
      service: 'payment',
    }),
};
