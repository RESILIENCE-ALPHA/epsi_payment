import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, ShieldAlert, Lock, Spinner } from './icons';
import { initials } from '../lib/format';

// Briques visuelles communes : boutons pilule, cartes, champs, alertes, avatars

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 shadow-[0_8px_24px_-8px_rgba(123,77,255,0.7)] disabled:shadow-none',
  secondary: 'bg-ink-700 text-white hover:bg-ink-600',
  ghost: 'bg-transparent text-muted hover:text-white hover:bg-white/5',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading = false, icon, className = '', children, disabled, ...props }: ButtonProps) {
  const sizing = size === 'lg' ? 'h-12 px-6 text-[15px]' : 'h-10 px-5 text-sm';
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50 ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Spinner className="text-base" /> : icon}
      {children}
    </button>
  );
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-3xl border border-white/[0.06] bg-ink-850 shadow-card ${className}`}>{children}</div>;
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: ReactNode;
  trailing?: ReactNode;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, trailing, id, className = '', ...props },
  ref,
) {
  const inputId = id ?? props.name;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={inputId} className="mb-2 block text-sm font-medium text-white/80">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`h-12 w-full rounded-2xl border bg-ink-900 px-4 text-[15px] text-white placeholder:text-white/30 transition focus:outline-none focus:ring-4 ${
            error
              ? 'border-loss/70 focus:border-loss focus:ring-loss/15'
              : 'border-white/10 hover:border-white/20 focus:border-brand-400 focus:ring-brand-500/20'
          } ${trailing ? 'pr-12' : ''}`}
          {...props}
        />
        {trailing && <div className="absolute inset-y-0 right-0 flex items-center pr-2">{trailing}</div>}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="mt-2 text-sm text-loss">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${inputId}-hint`} className="mt-2 text-sm text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
});

type AlertTone = 'danger' | 'warning' | 'locked';

const ALERT_TONES: Record<AlertTone, { box: string; icon: ReactNode }> = {
  danger: { box: 'border-loss/30 bg-loss/10 text-loss', icon: <ShieldAlert /> },
  warning: { box: 'border-warn/30 bg-warn/10 text-warn', icon: <AlertTriangle /> },
  locked: { box: 'border-brand-400/30 bg-brand-500/10 text-brand-300', icon: <Lock /> },
};

export function Alert({ tone, title, children }: { tone: AlertTone; title: string; children?: ReactNode }) {
  const { box, icon } = ALERT_TONES[tone];
  return (
    <div role="alert" className={`flex gap-3 rounded-2xl border p-4 ${box}`}>
      <span className="mt-0.5 shrink-0 text-lg">{icon}</span>
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        {children && <div className="mt-1 text-sm text-white/70">{children}</div>}
      </div>
    </div>
  );
}

const AVATAR_TINTS = ['bg-brand-500/20 text-brand-300', 'bg-gain/15 text-gain', 'bg-warn/15 text-warn', 'bg-sky-400/15 text-sky-300', 'bg-pink-400/15 text-pink-300'];

export function Avatar({ person, size = 'md' }: { person: { name: string | null; email: string }; size?: 'sm' | 'md' }) {
  // Teinte stable par personne
  const tint = AVATAR_TINTS[[...person.email].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AVATAR_TINTS.length];
  const sizing = size === 'sm' ? 'h-8 w-8 text-xs' : 'h-10 w-10 text-sm';
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${sizing} ${tint}`} aria-hidden="true">
      {initials(person)}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-white/[0.06] ${className}`} />;
}
