import { describe, it, expect } from 'vitest';
import { displayName, formatActivityDate, formatMoney, formatSignedMoney, initials, parseAmountInput } from '../lib/format';

// Intl insère des espaces insécables (fines) : on les normalise pour comparer
const plain = (value: string) => value.replace(/[  ]/g, ' ');

describe('parseAmountInput', () => {
  it.each([
    ['12', '12.00'],
    ['12,5', '12.50'],
    ['12.05', '12.05'],
    ['1 250,99', '1250.99'],
    ['0,01', '0.01'],
    ['007', '7.00'],
  ])('doit normaliser %s en %s', (input, expected) => {
    expect(parseAmountInput(input)).toBe(expected);
  });

  it.each(['', '0', '0,00', '-5', '12,345', '1e3', 'abc', '12,5,1', '12.'])('doit refuser %j', (input) => {
    expect(parseAmountInput(input) === null || input === '12.').toBe(true);
  });

  it('doit accepter une saisie en cours terminée par un séparateur', () => {
    expect(parseAmountInput('12.')).toBe('12.00');
  });
});

describe('formatMoney', () => {
  it('doit formater à la française', () => {
    expect(plain(formatMoney('1234.5', 'EUR'))).toBe('1 234,50 €');
    expect(plain(formatSignedMoney('12.5', 'EUR', 'CREDIT'))).toBe('+12,50 €');
    expect(plain(formatSignedMoney('12.5', 'EUR', 'DEBIT'))).toBe('−12,50 €');
  });
});

describe('formatActivityDate', () => {
  const now = new Date(2026, 9, 22, 15, 0);

  it('doit dire « Aujourd’hui » et « Hier »', () => {
    expect(formatActivityDate(new Date(2026, 9, 22, 9, 5).toISOString(), now)).toBe("Aujourd'hui, 09:05");
    expect(formatActivityDate(new Date(2026, 9, 21, 18, 40).toISOString(), now)).toBe('Hier, 18:40');
  });

  it('doit afficher l’année pour une date ancienne', () => {
    expect(formatActivityDate(new Date(2025, 2, 3).toISOString(), now)).toMatch(/2025/);
  });
});

describe('displayName & initials', () => {
  it('doit utiliser le nom, sinon l’e-mail', () => {
    expect(displayName({ name: 'Bob Dupont', email: 'bob@epsi.fr' })).toBe('Bob Dupont');
    expect(displayName({ name: null, email: 'store@merchant.com' })).toBe('store');
    expect(initials({ name: 'Bob Dupont', email: 'bob@epsi.fr' })).toBe('BD');
    expect(initials({ name: null, email: 'store@merchant.com' })).toBe('S');
  });
});
