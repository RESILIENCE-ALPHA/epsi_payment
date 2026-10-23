import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { HistoryEntry, Wallet } from '../api/types';
import { useServiceStatus } from '../components/ServiceBanner';

const REFRESH_MS = 30_000;
/** Pendant une panne : on resonde souvent pour constater le rétablissement au plus vite */
const REFRESH_DEGRADED_MS = 5_000;

interface WalletData {
  wallets: Wallet[] | null;
  selected: Wallet | null;
  history: HistoryEntry[] | null;
  error: ApiError | null;
  refreshing: boolean;
  select: (walletId: string) => void;
  refresh: () => Promise<void>;
}

/**
 * Portefeuilles de l'utilisateur et historique du portefeuille sélectionné.
 * Les dernières données reçues restent affichées pendant une panne (pas d'écran vide).
 */
export function useWalletData(historyLimit = 20): WalletData {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const status = useServiceStatus();

  const load = useCallback(
    async (walletId: string | null) => {
      setRefreshing(true);
      try {
        const { wallets: list } = await api.listWallets();
        setWallets(list);
        const target = list.find((wallet) => wallet.id === walletId) ?? list[0] ?? null;
        selectedRef.current = target?.id ?? null;
        setSelectedId(target?.id ?? null);

        if (target) {
          const detail = await api.getWallet(target.id, historyLimit);
          // L'utilisateur a pu changer de portefeuille pendant la requête
          if (selectedRef.current === target.id) setHistory(detail.transactions);
        } else {
          setHistory([]);
        }
        setError(null);
      } catch (err) {
        if (err instanceof ApiError) setError(err);
        else throw err;
      } finally {
        setRefreshing(false);
      }
    },
    [historyLimit],
  );

  useEffect(() => {
    void load(selectedRef.current);
  }, [load]);

  const degraded = status.payment === 'down' || status.api === 'down';
  useEffect(() => {
    const timer = setInterval(() => void load(selectedRef.current), degraded ? REFRESH_DEGRADED_MS : REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, degraded]);

  const select = useCallback(
    (walletId: string) => {
      if (walletId === selectedRef.current) return;
      selectedRef.current = walletId;
      setSelectedId(walletId);
      setHistory(null);
      void load(walletId);
    },
    [load],
  );

  const refresh = useCallback(() => load(selectedRef.current), [load]);

  return {
    wallets,
    selected: wallets?.find((wallet) => wallet.id === selectedId) ?? null,
    history,
    error,
    refreshing,
    select,
    refresh,
  };
}
