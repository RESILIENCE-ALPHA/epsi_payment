import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { prisma, UserRole, UserStatus } from '@epsi-pay/database';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 heures

export interface LoginParams {
  email: string;
  password: string;
  ipAddress: string;
  userAgent?: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: Date;
}

export interface LoginSuccess {
  success: true;
  status: 200;
  token: string;
  expiresAt: Date;
  user: UserSummary;
}

export interface LoginFailure {
  success: false;
  status: 400 | 401 | 403 | 423;
  error: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'IP_BLOCKED' | 'INVALID_INPUT';
  message: string;
  remainingAttempts?: number;
  lockedUntil?: Date | null;
}

export type LoginResult = LoginSuccess | LoginFailure;

/**
 * Calcule l'empreinte SHA-256 d'un jeton pour stockage sécurisé
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Vérifie si une adresse IP est bloquée
 */
export async function checkIpBlocked(ipAddress: string): Promise<{ isBlocked: boolean; reason?: string }> {
  const block = await prisma.blockedIp.findFirst({
    where: {
      ipAddress,
      isActive: true,
    },
  });

  if (!block) {
    return { isBlocked: false };
  }

  // Vérification expiration du blocage
  if (block.expiresAt && block.expiresAt < new Date()) {
    await prisma.blockedIp.update({
      where: { id: block.id },
      data: { isActive: false },
    });
    return { isBlocked: false };
  }

  return { isBlocked: true, reason: block.reason };
}

/**
 * Service d'authentification principal
 */
export async function login(params: LoginParams): Promise<LoginResult> {
  const { email, password, ipAddress, userAgent } = params;

  if (!email || !password) {
    return {
      success: false,
      status: 400,
      error: 'INVALID_INPUT',
      message: 'Email et mot de passe requis.',
    };
  }

  const normalizedEmail = email.trim().toLowerCase();

  // 1. Filtrage d'adresse IP bloquée (Résilience / WAF)
  const ipCheck = await checkIpBlocked(ipAddress);
  if (ipCheck.isBlocked) {
    await prisma.loginAttempt.create({
      data: {
        attemptedEmail: normalizedEmail,
        ipAddress,
        userAgent,
        isAuthenticated: false,
        failureReason: 'IP_BLOCKED',
      },
    });

    return {
      success: false,
      status: 403,
      error: 'IP_BLOCKED',
      message: `Adresse IP ${ipAddress} temporairement bloquée par le système de sécurité.`,
    };
  }

  // 2. Recherche de l'utilisateur
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    await prisma.loginAttempt.create({
      data: {
        attemptedEmail: normalizedEmail,
        targetUserId: null,
        ipAddress,
        userAgent,
        isAuthenticated: false,
        failureReason: 'USER_NOT_FOUND',
      },
    });

    return {
      success: false,
      status: 401,
      error: 'INVALID_CREDENTIALS',
      message: 'Identifiants invalides.',
    };
  }

  // 3. Vérification du verrouillage du compte (Scénario Brute Force)
  const now = new Date();
  if (user.status === UserStatus.LOCKED || (user.lockedUntil && user.lockedUntil > now)) {
    // Si la période de verrouillage est écoulée, on déverrouille le compte
    if (user.lockedUntil && user.lockedUntil <= now) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          status: UserStatus.ACTIVE,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    } else {
      await prisma.loginAttempt.create({
        data: {
          attemptedEmail: normalizedEmail,
          targetUserId: user.id,
          ipAddress,
          userAgent,
          isAuthenticated: false,
          failureReason: 'ACCOUNT_LOCKED',
        },
      });

      return {
        success: false,
        status: 423,
        error: 'ACCOUNT_LOCKED',
        message: 'Compte temporairement verrouillé pour des raisons de sécurité.',
        lockedUntil: user.lockedUntil,
      };
    }
  }

  // 4. Vérification du mot de passe
  const isMatch = await bcrypt.compare(password, user.passwordHash);

  if (!isMatch) {
    const newFailedCount = user.failedLoginAttempts + 1;
    const shouldLock = newFailedCount >= MAX_FAILED_ATTEMPTS;
    const lockedUntilDate = shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: newFailedCount,
        status: shouldLock ? UserStatus.LOCKED : user.status,
        lockedUntil: lockedUntilDate,
      },
    });

    // Journalisation pour le Machine Learning
    await prisma.loginAttempt.create({
      data: {
        attemptedEmail: normalizedEmail,
        targetUserId: user.id,
        ipAddress,
        userAgent,
        isAuthenticated: false,
        failureReason: shouldLock ? 'BRUTE_FORCE_LOCKED' : 'INVALID_CREDENTIALS',
      },
    });

    // Log d'audit de sécurité si le compte vient d'être verrouillé
    if (shouldLock) {
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'BRUTE_FORCE_ACCOUNT_LOCKED',
          severity: 'CRITICAL',
          ipAddress,
          details: {
            failedAttempts: newFailedCount,
            lockedUntil: lockedUntilDate?.toISOString(),
          },
        },
      });

      return {
        success: false,
        status: 423,
        error: 'ACCOUNT_LOCKED',
        message: 'Compte verrouillé pour 15 minutes suite à 5 tentatives de connexion échouées.',
        lockedUntil: lockedUntilDate,
      };
    }

    return {
      success: false,
      status: 401,
      error: 'INVALID_CREDENTIALS',
      message: 'Identifiants invalides.',
      remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - newFailedCount),
    };
  }

  // 5. Authentification réussie
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenDigest = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  // Remise à zéro des compteurs de tentative
  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      status: UserStatus.ACTIVE,
    },
  });

  // Création de la session
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: tokenDigest,
      ipAddress,
      userAgent,
      expiresAt,
      isValid: true,
    },
  });

  // Enregistrement succès (ML)
  await prisma.loginAttempt.create({
    data: {
      attemptedEmail: normalizedEmail,
      targetUserId: user.id,
      ipAddress,
      userAgent,
      isAuthenticated: true,
      failureReason: null,
    },
  });

  return {
    success: true,
    status: 200,
    token: rawToken,
    expiresAt,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    },
  };
}

/**
 * Invalide une session active (Déconnexion)
 */
export async function logout(rawToken: string): Promise<boolean> {
  const tokenDigest = hashToken(rawToken);
  const result = await prisma.session.updateMany({
    where: {
      tokenHash: tokenDigest,
      isValid: true,
    },
    data: {
      isValid: false,
    },
  });

  return result.count > 0;
}

/**
 * Récupère l'utilisateur associé à un jeton de session valide
 */
export async function getCurrentUser(rawToken: string): Promise<UserSummary | null> {
  const tokenDigest = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash: tokenDigest },
    include: { user: true },
  });

  if (!session || !session.isValid || session.expiresAt < new Date()) {
    return null;
  }

  const { user } = session;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}
