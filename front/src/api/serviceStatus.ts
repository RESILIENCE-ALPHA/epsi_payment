// État des services vu par le navigateur : alimenté par chaque réponse de la passerelle,
// affiché par le bandeau d'incident. Aucun appel dédié : on observe le trafic réel.

export type ServiceName = 'auth' | 'payment' | 'api';

export type ServiceStatus = Record<ServiceName, 'up' | 'down'>;

type Listener = (status: ServiceStatus) => void;

let status: ServiceStatus = { auth: 'up', payment: 'up', api: 'up' };
const listeners = new Set<Listener>();

export function getServiceStatus(): ServiceStatus {
  return status;
}

export function reportService(service: ServiceName, state: 'up' | 'down'): void {
  // Une réponse d'un service prouve aussi que la passerelle répond
  const next = { ...status, [service]: state, ...(state === 'up' ? { api: 'up' as const } : {}) };
  if (next.auth === status.auth && next.payment === status.payment && next.api === status.api) return;
  status = next;
  listeners.forEach((listener) => listener(status));
}

export function subscribeServiceStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Remise à zéro (tests) */
export function resetServiceStatus(): void {
  status = { auth: 'up', payment: 'up', api: 'up' };
  listeners.forEach((listener) => listener(status));
}
