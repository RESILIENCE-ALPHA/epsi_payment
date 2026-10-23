import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';
import { saveSession } from '../api/session';
import { resetServiceStatus } from '../api/serviceStatus';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ALICE = { id: 'u1', email: 'alice@epsi.fr', name: 'Alice Martin', role: 'CLIENT', status: 'ACTIVE', createdAt: '' } as const;
const WALLET = { id: 'w-alice', currency: 'EUR', balance: '100.00', status: 'ACTIVE', createdAt: '', updatedAt: '' };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('Écrans', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    resetServiceStatus();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  describe('Connexion', () => {
    const submit = async (status: number, body: unknown) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(status, body));
      const user = userEvent.setup();
      renderAt('/connexion');
      await user.type(screen.getByLabelText('Adresse e-mail'), 'alice@epsi.fr');
      await user.type(screen.getByLabelText('Mot de passe'), 'mauvais');
      await user.click(screen.getByRole('button', { name: 'Se connecter' }));
      return screen.findByRole('alert');
    };

    it('doit prévenir avant le verrouillage du compte', async () => {
      const alert = await submit(401, { error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.', remainingAttempts: 2 });

      expect(alert).toHaveTextContent('E-mail ou mot de passe incorrect.');
      expect(alert).toHaveTextContent('Encore 2 tentatives');
    });

    it('doit afficher le blocage de sécurité sans révéler l’adresse IP', async () => {
      const alert = await submit(403, { error: 'IP_BLOCKED', message: 'Adresse IP 203.0.113.7 temporairement bloquée.' });

      expect(alert).toHaveTextContent('Accès bloqué par le système de sécurité.');
      expect(alert).not.toHaveTextContent('203.0.113.7');
    });

    it('doit afficher un compte verrouillé', async () => {
      const alert = await submit(423, { error: 'ACCOUNT_LOCKED', message: '…', lockedUntil: new Date().toISOString() });

      expect(alert).toHaveTextContent('Compte temporairement verrouillé.');
    });

    it('doit ouvrir le tableau de bord après une connexion réussie', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/auth/login') return jsonResponse(200, { success: true, token: 't', expiresAt: '', user: ALICE });
        if (url === '/api/wallets') return jsonResponse(200, { wallets: [WALLET] });
        return jsonResponse(200, { wallet: WALLET, transactions: [] });
      });
      const user = userEvent.setup();
      renderAt('/connexion');

      await user.type(screen.getByLabelText('Adresse e-mail'), 'alice@epsi.fr');
      await user.type(screen.getByLabelText('Mot de passe'), 'Password123!');
      await user.click(screen.getByRole('button', { name: 'Se connecter' }));

      expect(await screen.findByText('Bonjour, Alice')).toBeInTheDocument();
    });
  });

  it('doit rediriger vers la connexion sans session', () => {
    renderAt('/payer');
    expect(screen.getByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
  });

  describe('Paiement', () => {
    beforeEach(() => saveSession({ token: 'tok', user: ALICE }));

    const fillAndReview = async () => {
      const user = userEvent.setup();
      renderAt('/payer');
      await screen.findByText(/Disponible/);
      await user.type(screen.getByLabelText('Montant'), '12,5');
      await user.type(screen.getByLabelText('Destinataire'), 'bob@epsi.fr');
      await user.click(screen.getByRole('button', { name: 'Continuer' }));
      return user;
    };

    it('doit réutiliser la même clé d’idempotence quand on relance un paiement non confirmé', async () => {
      const paymentCalls: RequestInit[] = [];
      let paymentAttempts = 0;
      fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (url === '/api/auth/me') return jsonResponse(200, { user: ALICE });
        if (url === '/api/wallets') return jsonResponse(200, { wallets: [WALLET] });
        if (url === '/api/payments') {
          paymentCalls.push(init);
          paymentAttempts += 1;
          return paymentAttempts === 1
            ? jsonResponse(504, { error: 'GATEWAY_TIMEOUT', service: 'payment' })
            : jsonResponse(201, { payment: { id: 'p1', reference: 'ref-1', amount: '12.50', currency: 'EUR', createdAt: new Date().toISOString() } });
        }
        return jsonResponse(404, {});
      });

      const user = await fillAndReview();
      await user.click(screen.getByRole('button', { name: /Confirmer et payer/ }));
      expect(await screen.findByText('Paiement non confirmé.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /Réessayer le paiement/ }));
      expect(await screen.findByText('Paiement envoyé')).toBeInTheDocument();

      const keys = paymentCalls.map((init) => (init.headers as Record<string, string>)['Idempotency-Key']);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
      expect(JSON.parse(paymentCalls[0].body as string)).toMatchObject({ amount: '12.50', recipientEmail: 'bob@epsi.fr' });
    });

    it('doit renvoyer sur le champ destinataire quand l’e-mail est inconnu', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url === '/api/auth/me') return jsonResponse(200, { user: ALICE });
        if (url === '/api/wallets') return jsonResponse(200, { wallets: [WALLET] });
        if (url === '/api/payments') return jsonResponse(404, { error: 'RECEIVER_NOT_FOUND', message: '…' });
        return jsonResponse(404, {});
      });

      const user = await fillAndReview();
      await user.click(screen.getByRole('button', { name: /Confirmer et payer/ }));

      expect(await screen.findByText('Aucun compte EPSI Pay actif ne correspond à cette adresse.')).toBeInTheDocument();
      expect(screen.getByLabelText('Destinataire')).toHaveAttribute('aria-invalid', 'true');
    });

    it('doit bloquer côté client un montant supérieur au solde', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === '/api/wallets' ? jsonResponse(200, { wallets: [WALLET] }) : jsonResponse(200, { user: ALICE }),
      );
      const user = userEvent.setup();
      renderAt('/payer');
      await screen.findByText(/Disponible/);

      await user.type(screen.getByLabelText('Montant'), '150');
      await user.type(screen.getByLabelText('Destinataire'), 'bob@epsi.fr');
      await user.click(screen.getByRole('button', { name: 'Continuer' }));

      expect(await screen.findByText('Solde insuffisant pour ce paiement.')).toBeInTheDocument();
      await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/payments')).toBe(false));
    });
  });
});
