import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { UserStatus } from '@epsi-pay/database';
import { AuthenticatedRequest } from '@epsi-pay/auth';

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * Protège les routes réservées aux services internes (moteur de remédiation).
 * Jeton partagé PAYMENT_INTERNAL_TOKEN, comparé en temps constant ; route désactivée s'il est absent.
 */
export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.PAYMENT_INTERNAL_TOKEN;
  if (!expected) {
    res.status(503).json({
      error: 'INTERNAL_ROUTE_DISABLED',
      message: 'PAYMENT_INTERNAL_TOKEN n\'est pas configuré sur le service paiement.',
    });
    return;
  }

  const provided = req.headers['x-internal-token'];
  if (typeof provided !== 'string' || !crypto.timingSafeEqual(digest(provided), digest(expected))) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Jeton interne invalide.' });
    return;
  }
  next();
}

/**
 * Refuse les comptes suspendus par un administrateur.
 * Un compte LOCKED (verrouillé par la protection brute force) garde ses sessions ouvertes :
 * sinon un attaquant pourrait bloquer les paiements d'une victime en échouant 5 connexions.
 */
export function requireActiveAccount(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (req.user?.status === UserStatus.SUSPENDED) {
    res.status(403).json({ error: 'ACCOUNT_SUSPENDED', message: 'Ce compte est suspendu.' });
    return;
  }
  next();
}
