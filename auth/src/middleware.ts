import { Request, Response, NextFunction } from 'express';
import { getCurrentUser, UserSummary } from './service';

export interface AuthenticatedRequest extends Request {
  user?: UserSummary;
  token?: string;
}

/**
 * Middleware vérifiant la présence et la validité d'un Bearer token
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Token d\'authentification requis dans l\'en-tête Authorization: Bearer <token>.',
    });
    return;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Token d\'authentification invalide.',
    });
    return;
  }

  try {
    const user = await getCurrentUser(token);
    if (!user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Session expirée ou invalide. Veuillez vous reconnecter.',
      });
      return;
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    console.error('[AUTH Middleware Error]:', error);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Erreur lors de la vérification de la session.',
    });
  }
}
