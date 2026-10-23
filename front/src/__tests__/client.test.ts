import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, onUnauthorized } from '../api/client';
import { saveSession } from '../api/session';
import { getServiceStatus, resetServiceStatus } from '../api/serviceStatus';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const USER = { id: 'u1', email: 'alice@epsi.fr', name: 'Alice', role: 'CLIENT', status: 'ACTIVE', createdAt: '' } as const;

describe('client API', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    resetServiceStatus();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('doit passer par /api, envoyer le jeton et la clé d’idempotence', async () => {
    saveSession({ token: 'tok-123', user: USER });
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { payment: { id: 'p1' } }));

    await api.createPayment({ senderWalletId: 'w1', recipientEmail: 'bob@epsi.fr', amount: '5.00' }, 'key-abcdefgh');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/payments');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-123', 'Idempotency-Key': 'key-abcdefgh' });
    expect(JSON.parse(init.body)).toEqual({ senderWalletId: 'w1', recipientEmail: 'bob@epsi.fr', amount: '5.00' });
  });

  it('ne doit pas envoyer de jeton à la connexion', async () => {
    saveSession({ token: 'ancien', user: USER });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, token: 't', user: USER }));

    await api.login('alice@epsi.fr', 'x');

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('doit transformer une réponse d’erreur en ApiError avec code et détails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { success: false, error: 'INVALID_CREDENTIALS', message: 'Identifiants invalides.', remainingAttempts: 2 }),
    );

    const error = await api.login('alice@epsi.fr', 'faux').catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', isUnavailable: false });
    expect(error.body.remainingAttempts).toBe(2);
  });

  it('doit signaler le service en panne sur 503, puis son rétablissement', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'SERVICE_UNAVAILABLE', service: 'payment' }));
    const error = await api.listWallets().catch((e) => e);

    expect(error.isUnavailable).toBe(true);
    expect(getServiceStatus().payment).toBe('down');

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { wallets: [] }));
    await api.listWallets();
    expect(getServiceStatus().payment).toBe('up');
  });

  it('doit traiter une passerelle injoignable comme une panne réessayable', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const error = await api.listWallets().catch((e) => e);

    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR', isUnavailable: true });
    expect(getServiceStatus().api).toBe('down');
  });

  it('doit notifier une session expirée (401 sur une requête authentifiée)', async () => {
    saveSession({ token: 'expire', user: USER });
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'UNAUTHORIZED' }));

    await api.listWallets().catch(() => {});

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
