import { Router } from 'express';
import { loginHandler, logoutHandler, getMeHandler } from './controller';
import { requireAuth } from './middleware';

export const authRouter: Router = Router();

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Authentification utilisateur & Création de session
 *     description: >
 *       Vérifie les identifiants, filtre les adresses IP bloquées, protège contre les attaques
 *       par force brute (verrouillage automatique après 5 échecs), et enregistre chaque tentative
 *       dans la table `login_attempts` pour alimenter le modèle de Machine Learning.
 *     tags:
 *       - Authentification
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: alice@epsi.fr
 *               password:
 *                 type: string
 *                 format: password
 *                 example: epsiWorkshopPasswordHashAliceSample123
 *     responses:
 *       200:
 *         description: Authentification réussie et session active
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 status:
 *                   type: integer
 *                   example: 200
 *                 token:
 *                   type: string
 *                   description: Jeton Bearer aléatoire sécurisé (validité 24h)
 *                   example: 3f8a4b2c1d9e7f...
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 user:
 *                   $ref: '#/components/schemas/UserProfile'
 *       400:
 *         description: Données d'entrée manquantes ou invalides
 *       401:
 *         description: Identifiants invalides (décrémente les essais restants)
 *       403:
 *         description: Adresse IP bloquée par le système de sécurité (WAF / Auto-remédiation)
 *       423:
 *         description: Compte verrouillé suite à 5 tentatives de connexion consécutives échouées
 */
authRouter.post('/login', loginHandler);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Déconnexion utilisateur
 *     description: Invalide la session active en base de données.
 *     tags:
 *       - Authentification
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Session invalidée avec succès
 *       401:
 *         description: Non authentifié ou token invalide
 */
authRouter.post('/logout', requireAuth, logoutHandler);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Profil de l'utilisateur connecté
 *     description: Retourne les informations de l'utilisateur associé au token de session.
 *     tags:
 *       - Authentification
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Informations du profil utilisateur
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/UserProfile'
 *       401:
 *         description: Token absent, expiré ou révoqué
 */
authRouter.get('/me', requireAuth, getMeHandler);
