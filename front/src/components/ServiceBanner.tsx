import { useEffect, useState } from 'react';
import { getServiceStatus, subscribeServiceStatus, type ServiceName, type ServiceStatus } from '../api/serviceStatus';
import { AlertTriangle } from './icons';

const MESSAGES: Record<ServiceName, string> = {
  api: 'EPSI Pay est momentanément injoignable.',
  auth: 'La connexion est momentanément indisponible.',
  payment: 'Les paiements sont momentanément indisponibles.',
};

export function useServiceStatus(): ServiceStatus {
  const [status, setStatus] = useState(getServiceStatus);
  useEffect(() => subscribeServiceStatus(setStatus), []);
  return status;
}

/**
 * Bandeau d'incident : apparaît dès qu'un service répond 502/503/504 (ou ne répond plus),
 * disparaît seul à la première réponse normale. Les données ne sont jamais perdues : un paiement
 * non confirmé peut être relancé sans risque de double débit (clé d'idempotence).
 */
export function ServiceBanner() {
  const status = useServiceStatus();
  const down = (['api', 'auth', 'payment'] as const).filter((service) => status[service] === 'down');
  if (down.length === 0) return null;

  return (
    <div role="status" aria-live="polite" className="border-b border-warn/20 bg-warn/10">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 text-sm sm:px-6">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-warn" />
        </span>
        <AlertTriangle className="hidden shrink-0 text-warn sm:block" />
        <p className="text-white/85">
          <span className="font-semibold text-warn">{MESSAGES[down[0]]}</span>{' '}
          Rétablissement automatique en cours, vos fonds sont en sécurité.
        </p>
      </div>
    </div>
  );
}
