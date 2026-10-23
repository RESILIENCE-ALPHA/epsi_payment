import type { User } from './types';

// Jeton de session opaque (validé en base par auth et payment) et profil associé.
// sessionStorage : la session ne survit pas à la fermeture de l'onglet. Le profil en cache permet
// de rester connecté après un rechargement même si auth est en panne (payment valide le jeton seul).
// Le stockage peut être indisponible (navigation privée) : on dégrade en mémoire.

const STORAGE_KEY = 'epsi-pay.session';

interface StoredSession {
  token: string;
  user: User;
}

let memorySession: StoredSession | null = null;

function read(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : memorySession;
  } catch {
    return memorySession;
  }
}

export function getSession(): StoredSession | null {
  const session = read();
  return session && typeof session.token === 'string' && session.user ? session : null;
}

export function getToken(): string | null {
  return getSession()?.token ?? null;
}

export function saveSession(session: StoredSession | null): void {
  memorySession = session;
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // stockage indisponible : la valeur en mémoire suffit pour l'onglet courant
  }
}
