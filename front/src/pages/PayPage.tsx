import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, newIdempotencyKey } from '../api/client';
import type { Payment, Wallet } from '../api/types';
import { useCurrentUser } from '../auth/AuthContext';
import { Alert, Button, Card, Field, Skeleton } from '../components/ui';
import { Check, ChevronLeft, Send } from '../components/icons';
import { formatActivityDate, formatMoney, MAX_PAYMENT_AMOUNT, parseAmountInput } from '../lib/format';

type Step = 'form' | 'review' | 'success';

interface Draft {
  senderWalletId: string;
  recipientEmail: string;
  amount: string;
  description: string;
}

interface FieldErrors {
  recipientEmail?: string;
  amount?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const QUICK_AMOUNTS = ['10', '20', '50', '100'];

/** Erreurs métier renvoyées vers le champ concerné ; les autres restent affichées au récapitulatif */
function fieldErrorFor(error: ApiError): FieldErrors | null {
  switch (error.code) {
    case 'RECEIVER_NOT_FOUND':
      return { recipientEmail: 'Aucun compte EPSI Pay actif ne correspond à cette adresse.' };
    case 'INSUFFICIENT_FUNDS':
      return { amount: 'Solde insuffisant pour ce paiement.' };
    case 'AMOUNT_TOO_HIGH':
    case 'INVALID_AMOUNT':
      return { amount: error.message };
    default:
      return null;
  }
}

function describePaymentError(error: ApiError): { tone: 'danger' | 'warning'; title: string; body: string } {
  if (error.isUnavailable) {
    return {
      tone: 'warning',
      title: 'Paiement non confirmé.',
      body: 'Le service de paiement ne répond pas. Vous pouvez réessayer sans risque : ce paiement ne sera jamais débité deux fois.',
    };
  }
  switch (error.code) {
    case 'IP_BLOCKED':
      return {
        tone: 'danger',
        title: 'Paiement bloqué par le système de sécurité.',
        body: 'Une activité suspecte a été détectée depuis votre réseau. Aucun montant n’a été débité.',
      };
    case 'CONCURRENT_UPDATE':
      return { tone: 'warning', title: 'Votre compte est en cours de mise à jour.', body: 'Réessayez dans un instant.' };
    case 'WALLET_NOT_ACTIVE':
      return { tone: 'danger', title: 'Ce portefeuille ne peut pas émettre de paiement.', body: error.message };
    default:
      return { tone: 'danger', title: 'Paiement refusé.', body: error.message };
  }
}

export function PayPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const preferredWalletId = (location.state as { walletId?: string } | null)?.walletId;

  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [draft, setDraft] = useState<Draft>({ senderWalletId: '', recipientEmail: '', amount: '', description: '' });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [payment, setPayment] = useState<Payment | null>(null);
  // Une clé par paiement : conservée entre les nouveaux essais, renouvelée si le paiement change
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .listWallets()
        .then(({ wallets: list }) => {
          if (cancelled) return;
          setWallets(list);
          setLoadError(null);
          setDraft((current) =>
            current.senderWalletId
              ? current
              : {
                  ...current,
                  senderWalletId:
                    list.find((w) => w.id === preferredWalletId && w.status === 'ACTIVE')?.id ??
                    list.find((w) => w.status === 'ACTIVE')?.id ??
                    '',
                },
          );
        })
        .catch((error) => {
          if (cancelled || !(error instanceof ApiError)) return;
          setLoadError(error);
          // Panne : nouvel essai automatique
          if (error.isUnavailable) setTimeout(() => !cancelled && void load(), 5000);
        });
    void load();
    return () => {
      cancelled = true;
    };
  }, [preferredWalletId]);

  const sender = wallets?.find((wallet) => wallet.id === draft.senderWalletId) ?? null;
  const currency = sender?.currency ?? 'EUR';
  const normalizedAmount = parseAmountInput(draft.amount);
  const submitFeedback = submitError ? describePaymentError(submitError) : null;

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setFieldErrors((current) => ({
      ...current,
      ...('recipientEmail' in patch ? { recipientEmail: undefined } : {}),
      ...('amount' in patch ? { amount: undefined } : {}),
    }));
    idempotencyKey.current = null;
  };

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {};
    const email = draft.recipientEmail.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) errors.recipientEmail = 'Saisissez une adresse e-mail valide.';
    else if (email === user.email.toLowerCase()) errors.recipientEmail = 'Vous ne pouvez pas vous payer vous-même.';

    if (!normalizedAmount) errors.amount = 'Saisissez un montant positif, avec au plus 2 décimales.';
    else if (Number(normalizedAmount) > MAX_PAYMENT_AMOUNT)
      errors.amount = `Le montant ne peut pas dépasser ${formatMoney(MAX_PAYMENT_AMOUNT, currency)}.`;
    else if (sender && Number(normalizedAmount) > Number(sender.balance)) errors.amount = 'Solde insuffisant pour ce paiement.';
    return errors;
  };

  const handleContinue = (event: FormEvent) => {
    event.preventDefault();
    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !sender) return;
    setSubmitError(null);
    idempotencyKey.current ??= newIdempotencyKey();
    setStep('review');
  };

  const handleConfirm = async () => {
    if (!sender || !normalizedAmount) return;
    idempotencyKey.current ??= newIdempotencyKey();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { payment: created } = await api.createPayment(
        {
          senderWalletId: sender.id,
          recipientEmail: draft.recipientEmail.trim().toLowerCase(),
          amount: normalizedAmount,
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        },
        idempotencyKey.current,
      );
      setPayment(created);
      setStep('success');
      idempotencyKey.current = null;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const fieldError = fieldErrorFor(error);
      if (fieldError) {
        // Le paiement a été refusé, pas débité : la correction donnera lieu à une nouvelle clé
        idempotencyKey.current = null;
        setFieldErrors(fieldError);
        setStep('form');
      } else {
        // Panne ou refus : la même clé est conservée, un nouvel essai ne peut pas débiter deux fois
        setSubmitError(error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setDraft((current) => ({ ...current, recipientEmail: '', amount: '', description: '' }));
    setPayment(null);
    setStep('form');
    void api.listWallets().then(({ wallets: list }) => setWallets(list)).catch(() => {});
  };

  return (
    <div className="mx-auto max-w-lg">
      {step !== 'success' && (
        <div className="mb-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => (step === 'review' ? setStep('form') : navigate('/'))}
            className="flex h-10 w-10 items-center justify-center rounded-full text-xl text-muted transition hover:bg-white/5 hover:text-white"
            aria-label="Retour"
          >
            <ChevronLeft />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">{step === 'form' ? 'Payer' : 'Vérifier le paiement'}</h1>
            <p className="text-sm text-muted">Étape {step === 'form' ? 1 : 2} sur 2</p>
          </div>
        </div>
      )}

      {step === 'form' && (
        <Card className="p-6 sm:p-8">
          {loadError && !wallets && (
            <div className="mb-6">
              <Alert tone="warning" title="Portefeuilles indisponibles.">
                {loadError.isUnavailable ? 'Nouvel essai automatique dans quelques secondes.' : loadError.message}
              </Alert>
            </div>
          )}

          <form onSubmit={handleContinue} noValidate className="space-y-6">
            {/* Montant */}
            <div>
              <label htmlFor="amount" className="block text-center text-sm font-medium text-muted">
                Montant
              </label>
              <div className="mt-3 flex items-baseline justify-center gap-2">
                <input
                  id="amount"
                  name="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={draft.amount}
                  onChange={(event) => update({ amount: event.target.value })}
                  aria-invalid={fieldErrors.amount ? true : undefined}
                  aria-describedby="amount-help"
                  className="w-full min-w-0 bg-transparent text-center text-6xl font-bold tracking-tight text-white tabular-nums placeholder:text-white/20 focus:outline-none"
                  autoFocus
                />
              </div>
              <p id="amount-help" className={`mt-2 text-center text-sm ${fieldErrors.amount ? 'text-loss' : 'text-muted'}`}>
                {fieldErrors.amount ??
                  (sender ? `Disponible : ${formatMoney(sender.balance, currency)}` : wallets ? 'Aucun portefeuille actif' : ' ')}
              </p>
              <div className="mt-4 flex justify-center gap-2">
                {QUICK_AMOUNTS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => update({ amount: value })}
                    className="rounded-full border border-white/10 px-3.5 py-1.5 text-sm font-medium text-white/80 transition hover:border-brand-400/60 hover:text-white"
                  >
                    {formatMoney(value, currency).replace(/[,.]00/, '')}
                  </button>
                ))}
              </div>
            </div>

            <div className="h-px bg-white/[0.06]" />

            {/* Portefeuille émetteur */}
            <div>
              <label htmlFor="senderWalletId" className="mb-2 block text-sm font-medium text-white/80">
                Depuis
              </label>
              {wallets ? (
                <select
                  id="senderWalletId"
                  value={draft.senderWalletId}
                  onChange={(event) => update({ senderWalletId: event.target.value })}
                  className="h-12 w-full appearance-none rounded-2xl border border-white/10 bg-ink-900 px-4 text-[15px] text-white focus:border-brand-400 focus:outline-none focus:ring-4 focus:ring-brand-500/20"
                >
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id} disabled={wallet.status !== 'ACTIVE'}>
                      Portefeuille {wallet.currency} · {formatMoney(wallet.balance, wallet.currency)}
                      {wallet.status !== 'ACTIVE' ? ' (inactif)' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <Skeleton className="h-12 w-full rounded-2xl" />
              )}
            </div>

            <Field
              label="Destinataire"
              name="recipientEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="adresse e-mail du destinataire"
              value={draft.recipientEmail}
              onChange={(event) => update({ recipientEmail: event.target.value })}
              error={fieldErrors.recipientEmail}
            />

            <Field
              label="Note (facultatif)"
              name="description"
              maxLength={255}
              placeholder="Ex. : remboursement du déjeuner"
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
            />

            <Button type="submit" size="lg" className="w-full" disabled={!sender}>
              Continuer
            </Button>
          </form>
        </Card>
      )}

      {step === 'review' && sender && normalizedAmount && (
        <Card className="p-6 sm:p-8">
          <p className="text-center text-sm font-medium text-muted">Vous envoyez</p>
          <p className="mt-2 text-center text-5xl font-bold tracking-tight text-white tabular-nums">
            {formatMoney(normalizedAmount, currency)}
          </p>

          <dl className="mt-8 space-y-4 rounded-2xl bg-white/[0.03] p-5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">À</dt>
              <dd className="truncate font-medium text-white">{draft.recipientEmail.trim().toLowerCase()}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Depuis</dt>
              <dd className="font-medium text-white">Portefeuille {sender.currency}</dd>
            </div>
            {draft.description.trim() && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Note</dt>
                <dd className="truncate font-medium text-white">{draft.description.trim()}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Frais</dt>
              <dd className="font-medium text-gain">Gratuit</dd>
            </div>
            <div className="h-px bg-white/[0.06]" />
            <div className="flex justify-between gap-4 text-base">
              <dt className="font-semibold text-white">Total débité</dt>
              <dd className="font-bold text-white tabular-nums">{formatMoney(normalizedAmount, currency)}</dd>
            </div>
          </dl>

          {submitFeedback && (
            <div className="mt-6">
              <Alert tone={submitFeedback.tone} title={submitFeedback.title}>
                {submitFeedback.body}
              </Alert>
            </div>
          )}

          <div className="mt-8 grid gap-3 sm:grid-cols-[auto_1fr]">
            <Button size="lg" variant="secondary" onClick={() => setStep('form')} disabled={submitting}>
              Modifier
            </Button>
            <Button size="lg" icon={<Send />} loading={submitting} onClick={() => void handleConfirm()}>
              {submitError?.isUnavailable ? 'Réessayer le paiement' : 'Confirmer et payer'}
            </Button>
          </div>
        </Card>
      )}

      {step === 'success' && payment && (
        <Card className="p-8 text-center sm:p-10">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-gain/15 text-4xl text-gain shadow-[0_0_60px_-10px_rgba(47,210,138,0.6)]">
            <Check strokeWidth={2.5} />
          </div>
          <h1 className="mt-6 text-2xl font-bold text-white">Paiement envoyé</h1>
          <p className="mt-3 text-4xl font-bold tracking-tight text-white tabular-nums">
            {formatMoney(payment.amount, payment.currency)}
          </p>
          <p className="mt-2 text-muted">à {draft.recipientEmail.trim().toLowerCase()}</p>

          <dl className="mt-8 space-y-3 rounded-2xl bg-white/[0.03] p-5 text-left text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Référence</dt>
              <dd className="truncate font-mono text-xs text-white/80">{payment.reference}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Date</dt>
              <dd className="text-white/80">{formatActivityDate(payment.createdAt)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Statut</dt>
              <dd className="font-medium text-gain">Effectué</dd>
            </div>
          </dl>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <Button size="lg" variant="secondary" onClick={restart}>
              Nouveau paiement
            </Button>
            <Button size="lg" onClick={() => navigate('/')}>
              Retour à l&rsquo;accueil
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
