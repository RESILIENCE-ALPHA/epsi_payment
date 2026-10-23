import { Request, Response } from 'express';
import { login, logout } from './service';
import { AuthenticatedRequest } from './middleware';

/**
 * Traduit TRUST_PROXY en valeur du réglage Express `trust proxy`.
 *
 * - un entier : nombre de proxys de confiance devant le service (Compose : 1 = passerelle API,
 *   Kubernetes : 2 = Ingress + passerelle). Valeur par défaut : 1.
 * - "true" / "false", ou une liste de sous-réseaux ("10.0.0.0/8, 172.16.0.0/12").
 */
export function parseTrustProxy(value: string | undefined): number | boolean | string {
  if (value === undefined || value.trim() === '') return 1;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

/**
 * Adresse IP cliente réelle, résolue par Express selon `trust proxy`.
 *
 * Seules les entrées de X-Forwarded-For ajoutées par les proxys de confiance sont prises en compte :
 * une valeur forgée par le client (ex: X-Forwarded-For: 6.6.6.6) est ignorée, ce qui empêche
 * de contourner le blocage IP ou de faire bloquer l'adresse d'un tiers.
 */
export function extractClientIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
  // Adresse IPv4 vue via une socket IPv6 (::ffff:192.168.1.50) : on garde la forme IPv4 pour blocked_ips
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/**
 * Endpoint POST /auth/login
 */
export async function loginHandler(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body || {};
  const ipAddress = extractClientIp(req);
  const userAgent = req.headers['user-agent'];

  const result = await login({
    email,
    password,
    ipAddress,
    userAgent,
  });

  res.status(result.status).json(result);
}

/**
 * Endpoint POST /auth/logout
 */
export async function logoutHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.token) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Non authentifié.' });
    return;
  }

  await logout(req.token);
  res.status(200).json({
    message: 'Déconnexion réussie. La session a été invalidée.',
  });
}

/**
 * Endpoint GET /auth/me
 */
export async function getMeHandler(req: AuthenticatedRequest, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Non authentifié.' });
    return;
  }

  res.status(200).json({
    user: req.user,
  });
}
