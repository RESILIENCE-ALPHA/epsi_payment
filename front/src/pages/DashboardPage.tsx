import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../auth/AuthContext';
import { ActivityList } from '../components/ActivityList';
import { useServiceStatus } from '../components/ServiceBanner';
import { Alert, Button, Card, Skeleton } from '../components/ui';
import { Refresh, Send, ShieldCheck, WalletIcon } from '../components/icons';
import { displayName, formatMoney } from '../lib/format';
import { useWalletData } from '../lib/useWalletData';
import type { Wallet } from '../api/types';

/** Solde mis en avant : partie entière en grand, centimes atténués */
function BigBalance({ wallet }: { wallet: Wallet }) {
  const formatted = formatMoney(wallet.balance, wallet.currency);
  const match = formatted.match(/^(.*?)([,.]\d{2})(\s?\D*)$/);
  if (!match) return <span>{formatted}</span>;
  const [, units, cents, symbol] = match;
  return (
    <span className="tabular-nums">
      {units}
      <span className="text-white/40">{cents}</span>
      <span className="ml-1 text-white/60">{symbol.trim()}</span>
    </span>
  );
}

const HISTORY_PAGE = 10;
const HISTORY_MAX = 100;

const SERVICES = [
  { key: 'api', label: 'Passerelle' },
  { key: 'auth', label: 'Authentification' },
  { key: 'payment', label: 'Paiements' },
] as const;

function PlatformStatus() {
  const status = useServiceStatus();
  const allUp = SERVICES.every(({ key }) => status[key] === 'up');

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">État de la plateforme</h2>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${allUp ? 'bg-gain/15 text-gain' : 'bg-warn/15 text-warn'}`}
        >
          {allUp ? 'Opérationnelle' : 'Incident en cours'}
        </span>
      </div>
      <ul className="mt-5 space-y-3">
        {SERVICES.map(({ key, label }) => {
          const up = status[key] === 'up';
          return (
            <li key={key} className="flex items-center justify-between text-sm">
              <span className="text-white/80">{label}</span>
              <span className={`inline-flex items-center gap-2 font-medium ${up ? 'text-gain' : 'text-warn'}`}>
                <span className={`h-2 w-2 rounded-full ${up ? 'bg-gain' : 'animate-pulse bg-warn'}`} />
                {up ? 'Opérationnel' : 'Rétablissement…'}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex gap-3 rounded-2xl bg-white/[0.03] p-4 text-sm">
        <ShieldCheck className="mt-0.5 shrink-0 text-lg text-brand-300" />
        <p className="text-muted">
          Accès surveillés en temps réel : toute activité suspecte est bloquée automatiquement.
        </p>
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const { wallets, selected, history, error, refreshing, select, refresh } = useWalletData(historyLimit);
  const canShowMore = history !== null && history.length === historyLimit && historyLimit < HISTORY_MAX;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white">Bonjour, {displayName(user).split(' ')[0]}</h1>
        <p className="mt-1 text-muted">Voici l&rsquo;état de votre compte.</p>
      </div>

      {error && !wallets && (
        <Alert tone="warning" title="Impossible de charger vos portefeuilles.">
          {error.isUnavailable ? 'Le service de paiement se rétablit, nouvel essai automatique dans quelques secondes.' : error.message}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="relative overflow-hidden p-6 sm:p-8 lg:col-span-2">
          <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-500/20 blur-[90px]" />
          <div className="relative">
            <div className="flex items-center gap-2 text-sm font-medium text-muted">
              <WalletIcon className="text-base" />
              Solde disponible
              {selected && (
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-white/70">{selected.currency}</span>
              )}
            </div>

            <div className="mt-3 text-[44px] font-bold leading-none tracking-tight text-white sm:text-6xl" aria-live="polite">
              {selected ? <BigBalance wallet={selected} /> : <Skeleton className="h-14 w-64" />}
            </div>

            {selected && selected.status !== 'ACTIVE' && (
              <p className="mt-3 text-sm text-warn">Ce portefeuille est {selected.status === 'FROZEN' ? 'gelé' : 'clôturé'} : les paiements sont suspendus.</p>
            )}

            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" icon={<Send />} onClick={() => navigate('/payer', { state: { walletId: selected?.id } })}>
                Payer
              </Button>
              <Button
                size="lg"
                variant="secondary"
                icon={<Refresh className={refreshing ? 'animate-spin' : ''} />}
                onClick={() => void refresh()}
                disabled={refreshing}
              >
                Actualiser
              </Button>
            </div>

            {wallets && wallets.length > 1 && (
              <div className="mt-8 flex flex-wrap gap-2" role="tablist" aria-label="Portefeuilles">
                {wallets.map((wallet) => (
                  <button
                    key={wallet.id}
                    role="tab"
                    aria-selected={wallet.id === selected?.id}
                    onClick={() => select(wallet.id)}
                    className={`rounded-2xl border px-4 py-2 text-left text-sm transition ${
                      wallet.id === selected?.id
                        ? 'border-brand-400/60 bg-brand-500/10 text-white'
                        : 'border-white/10 text-muted hover:border-white/20 hover:text-white'
                    }`}
                  >
                    <span className="block text-xs">{wallet.currency}</span>
                    <span className="font-semibold tabular-nums">{formatMoney(wallet.balance, wallet.currency)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Card>

        <PlatformStatus />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <h2 className="font-semibold text-white">Activité récente</h2>
          {error && wallets && <span className="text-xs text-warn">Données non actualisées</span>}
        </div>
        <ActivityList entries={wallets && wallets.length === 0 ? [] : history} />
        {canShowMore && (
          <div className="border-t border-white/[0.06] p-3 text-center">
            <Button variant="ghost" onClick={() => setHistoryLimit((limit) => Math.min(limit + 20, HISTORY_MAX))} loading={refreshing}>
              Afficher plus
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
