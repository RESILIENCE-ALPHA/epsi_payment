import type { HistoryEntry } from '../api/types';
import { displayName, formatActivityDate, formatSignedMoney } from '../lib/format';
import { Avatar, Skeleton } from './ui';
import { ArrowDownLeft, ArrowUpRight, ShieldCheck } from './icons';

const TYPE_LABELS: Record<HistoryEntry['type'], string | null> = {
  PAYMENT: null,
  TRANSFER: 'Virement',
  REFUND: 'Remboursement',
  VALIDATION_TEST: 'Test de validation',
};

function ActivityRow({ entry }: { entry: HistoryEntry }) {
  const credit = entry.direction === 'CREDIT';
  const party = entry.counterparty;
  const label = TYPE_LABELS[entry.type];
  const failed = entry.status !== 'SUCCESS';

  return (
    <li className="flex items-center gap-4 px-5 py-4 transition hover:bg-white/[0.02] sm:px-6">
      <div className="relative">
        {entry.type === 'VALIDATION_TEST' ? (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-gain/15 text-lg text-gain" aria-hidden="true">
            <ShieldCheck />
          </span>
        ) : party ? (
          <Avatar person={party} />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.06]" aria-hidden="true" />
        )}
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-ink-850 text-[10px] ${
            credit ? 'bg-gain text-ink-950' : 'bg-ink-600 text-white'
          }`}
          aria-hidden="true"
        >
          {credit ? <ArrowDownLeft strokeWidth={3} /> : <ArrowUpRight strokeWidth={3} />}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-white">
          {party ? displayName(party) : credit ? 'Crédit' : 'Débit'}
          {label && (
            <span className="ml-2 rounded-full bg-white/[0.06] px-2 py-0.5 align-middle text-[11px] font-medium text-muted">
              {label}
            </span>
          )}
        </p>
        <p className="truncate text-sm text-muted">
          {entry.description || (party ? party.email : entry.reference)} · {formatActivityDate(entry.createdAt)}
        </p>
      </div>

      <div className="text-right">
        <p className={`font-semibold tabular-nums ${failed ? 'text-muted line-through' : credit ? 'text-gain' : 'text-white'}`}>
          {formatSignedMoney(entry.amount, entry.currency, entry.direction)}
        </p>
        {failed && <p className="text-xs text-loss">{entry.status === 'BLOCKED' ? 'Bloqué' : 'Échoué'}</p>}
      </div>
    </li>
  );
}

export function ActivityList({ entries }: { entries: HistoryEntry[] | null }) {
  if (entries === null) {
    return (
      <ul className="divide-y divide-white/[0.05]" aria-busy="true" aria-label="Chargement de l'activité">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex items-center gap-4 px-6 py-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-4 w-20" />
          </li>
        ))}
      </ul>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="px-6 py-14 text-center">
        <p className="font-medium text-white">Aucune opération pour l&rsquo;instant</p>
        <p className="mt-1 text-sm text-muted">Vos paiements envoyés et reçus apparaîtront ici.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-white/[0.05]">
      {entries.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} />
      ))}
    </ul>
  );
}
