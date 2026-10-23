// Mise en forme française des montants et des dates ; saisie des montants sans flottant

export const MAX_PAYMENT_AMOUNT = 10_000;

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string): Intl.NumberFormat {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: 2 });
    moneyFormatters.set(currency, formatter);
  }
  return formatter;
}

/** "1234.5" → "1 234,50 €" (montants API en chaîne ; < 10^10, donc exacts en double) */
export function formatMoney(amount: string | number, currency = 'EUR'): string {
  return moneyFormatter(currency).format(typeof amount === 'number' ? amount : Number(amount));
}

/** Montant signé pour l'historique : "+12,50 €" / "−12,50 €" */
export function formatSignedMoney(amount: string, currency: string, direction: 'DEBIT' | 'CREDIT'): string {
  return `${direction === 'CREDIT' ? '+' : '−'}${formatMoney(amount, currency)}`;
}

/**
 * Saisie utilisateur → montant normalisé pour l'API ("12,5" → "12.50"), ou null si invalide.
 * Accepte virgule ou point, espaces de milliers ; au plus 2 décimales ; strictement positif.
 */
export function parseAmountInput(input: string): string | null {
  const compact = input.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^\d{1,10}(\.\d{0,2})?$/.test(compact)) return null;
  const [units, cents = ''] = compact.split('.');
  const normalized = `${BigInt(units)}.${cents.padEnd(2, '0')}`;
  return Number(normalized) > 0 ? normalized : null;
}

const timeFormatter = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const dayFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const fullFormatter = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

/** "Aujourd'hui, 14:32" · "Hier, 09:05" · "12 oct., 18:40" · "3 mars 2025" */
export function formatActivityDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (days === 0) return `Aujourd'hui, ${timeFormatter.format(date)}`;
  if (days === 1) return `Hier, ${timeFormatter.format(date)}`;
  if (date.getFullYear() === now.getFullYear()) return `${dayFormatter.format(date)}, ${timeFormatter.format(date)}`;
  return fullFormatter.format(date);
}

export function formatTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** Nom affiché d'une personne : son nom, sinon la partie locale de l'e-mail */
export function displayName(person: { name: string | null; email: string }): string {
  return person.name?.trim() || person.email.split('@')[0];
}

/** Initiales pour l'avatar : "Bob Dupont" → "BD", "store@merchant.com" → "S" */
export function initials(person: { name: string | null; email: string }): string {
  const source = person.name?.trim();
  if (!source) return person.email.charAt(0).toUpperCase();
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}
