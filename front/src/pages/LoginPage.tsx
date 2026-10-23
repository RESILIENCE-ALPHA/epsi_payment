import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { ServiceBanner } from '../components/ServiceBanner';
import { Alert, Button, Field } from '../components/ui';
import { Activity, Eye, EyeOff, ShieldCheck, Zap } from '../components/icons';
import { formatTime } from '../lib/format';

/** Traduit un refus de connexion en message clair, sans révéler d'information exploitable */
function describeLoginError(error: unknown): { tone: 'danger' | 'warning' | 'locked'; title: string; body?: ReactNode } {
  if (!(error instanceof ApiError)) {
    return { tone: 'warning', title: 'Une erreur inattendue est survenue.', body: 'Réessayez dans un instant.' };
  }
  if (error.isUnavailable) {
    return {
      tone: 'warning',
      title: 'Connexion momentanément indisponible.',
      body: 'Le service se rétablit automatiquement. Réessayez dans quelques secondes.',
    };
  }
  switch (error.code) {
    case 'IP_BLOCKED':
      return {
        tone: 'danger',
        title: 'Accès bloqué par le système de sécurité.',
        body: 'Une activité suspecte a été détectée depuis votre réseau. Les connexions sont suspendues temporairement.',
      };
    case 'ACCOUNT_LOCKED': {
      const until = error.body.lockedUntil;
      return {
        tone: 'locked',
        title: 'Compte temporairement verrouillé.',
        body: until
          ? `Trop de tentatives échouées. Réessayez après ${formatTime(until)}.`
          : 'Trop de tentatives échouées. Réessayez plus tard.',
      };
    }
    case 'INVALID_CREDENTIALS': {
      const remaining = error.body.remainingAttempts;
      return {
        tone: 'danger',
        title: 'E-mail ou mot de passe incorrect.',
        body:
          remaining !== undefined && remaining <= 3
            ? `Encore ${remaining} tentative${remaining > 1 ? 's' : ''} avant le verrouillage temporaire du compte.`
            : undefined,
      };
    }
    case 'INVALID_INPUT':
      return { tone: 'warning', title: 'Renseignez votre e-mail et votre mot de passe.' };
    default:
      return { tone: 'warning', title: error.message };
  }
}

const HIGHLIGHTS = [
  { icon: <Zap />, title: 'Paiements instantanés', text: 'Envoyez de l’argent à n’importe quel compte EPSI Pay avec une simple adresse e-mail.' },
  { icon: <ShieldCheck />, title: 'Sécurité active', text: 'Détection des attaques en temps réel et blocage automatique des accès suspects.' },
  { icon: <Activity />, title: 'Toujours disponible', text: 'Une plateforme qui se rétablit seule : aucun paiement perdu, jamais de double débit.' },
];

export function LoginPage() {
  const { state, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (state.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const feedback = error ? describeLoginError(error) : null;
  const expired = state.status === 'anonymous' && state.reason === 'expired';

  return (
    <div className="flex min-h-screen flex-col bg-ink-950">
      <ServiceBanner />
      <div className="grid flex-1 lg:grid-cols-[1.1fr_1fr]">
        {/* Panneau de présentation */}
        <aside className="relative hidden overflow-hidden border-r border-white/[0.06] bg-ink-900 lg:flex lg:flex-col lg:justify-between lg:p-12">
          <div className="pointer-events-none absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-brand-500/25 blur-[120px]" />
          <div className="pointer-events-none absolute -bottom-48 right-0 h-[420px] w-[420px] rounded-full bg-sky-400/10 blur-[120px]" />

          <Logo className="relative text-[40px] text-white" />

          <div className="relative max-w-md">
            <h1 className="text-5xl font-bold leading-[1.05] tracking-tight text-white">
              L&rsquo;argent circule.
              <br />
              <span className="bg-gradient-to-r from-brand-300 to-brand-500 bg-clip-text text-transparent">
                La sécurité reste.
              </span>
            </h1>
            <ul className="mt-10 space-y-6">
              {HIGHLIGHTS.map((item) => (
                <li key={item.title} className="flex gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/[0.06] text-lg text-brand-300">
                    {item.icon}
                  </span>
                  <div>
                    <p className="font-semibold text-white">{item.title}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-muted">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <p className="relative text-xs text-white/30">Projet Workshop EPSI · RESILIENCE-ALPHA</p>
        </aside>

        {/* Formulaire */}
        <section className="flex items-center justify-center px-4 py-12 sm:px-8">
          <div className="w-full max-w-[400px]">
            <Logo className="mb-10 text-[34px] text-white lg:hidden" />

            <h2 className="text-3xl font-bold tracking-tight text-white">Connexion</h2>
            <p className="mt-2 text-muted">Accédez à votre compte EPSI Pay.</p>

            <form className="mt-8 space-y-5" onSubmit={handleSubmit} noValidate>
              {expired && !feedback && (
                <Alert tone="locked" title="Votre session a expiré.">
                  Reconnectez-vous pour continuer.
                </Alert>
              )}
              {feedback && (
                <Alert tone={feedback.tone} title={feedback.title}>
                  {feedback.body}
                </Alert>
              )}

              <Field
                label="Adresse e-mail"
                name="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                placeholder="vous@exemple.fr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
              />

              <Field
                label="Mot de passe"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="••••••••••"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                trailing={
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="flex h-9 w-9 items-center justify-center rounded-xl text-lg text-muted hover:bg-white/5 hover:text-white"
                    aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  >
                    {showPassword ? <EyeOff /> : <Eye />}
                  </button>
                }
              />

              <Button type="submit" size="lg" className="w-full" loading={submitting} disabled={!email || !password}>
                Se connecter
              </Button>
            </form>

            {import.meta.env.DEV && (
              <p className="mt-8 rounded-2xl border border-dashed border-white/10 p-4 text-xs leading-relaxed text-muted">
                <span className="font-semibold text-white/70">Développement</span> — comptes du seed :
                alice@epsi.fr, bob@epsi.fr, store@merchant.com · mot de passe <code className="text-white/70">Password123!</code>
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
