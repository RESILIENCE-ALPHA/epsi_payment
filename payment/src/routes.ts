import { Router } from 'express';
import { requireAuth } from '@epsi-pay/auth';
import {
  listWalletsHandler,
  getWalletHandler,
  createPaymentHandler,
  getPaymentHandler,
  testValidationHandler,
} from './controller';
import { requireActiveAccount, requireInternalToken } from './middleware';

export const paymentRouter: Router = Router();

/**
 * @openapi
 * /wallets:
 *   get:
 *     summary: Portefeuilles de l'utilisateur connecté
 *     tags:
 *       - Portefeuilles
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des portefeuilles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallets:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Wallet'
 *       401:
 *         description: Non authentifié
 */
paymentRouter.get('/wallets', requireAuth, requireActiveAccount, listWalletsHandler);

/**
 * @openapi
 * /wallets/{id}:
 *   get:
 *     summary: Solde et historique d'un portefeuille
 *     description: Seul le propriétaire peut consulter son portefeuille ; sinon 404.
 *     tags:
 *       - Portefeuilles
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *     responses:
 *       200:
 *         description: Portefeuille et dernières transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   $ref: '#/components/schemas/Wallet'
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/HistoryEntry'
 *       401:
 *         description: Non authentifié
 *       404:
 *         description: Portefeuille introuvable
 */
paymentRouter.get('/wallets/:id', requireAuth, requireActiveAccount, getWalletHandler);

/**
 * @openapi
 * /payments:
 *   post:
 *     summary: Effectuer un paiement
 *     description: >
 *       Débite un portefeuille de l'utilisateur et crédite le destinataire dans une transaction SQL unique.
 *       L'en-tête `Idempotency-Key` est obligatoire : rejouer la même requête (retry réseau) renvoie le
 *       paiement déjà effectué (`200` + `Idempotent-Replayed: true`) sans nouveau débit.
 *       Le destinataire est désigné par `receiverWalletId` ou par `recipientEmail` (exactement l'un des deux) ;
 *       par e-mail, c'est son portefeuille actif dans la devise de l'émetteur qui est crédité.
 *     tags:
 *       - Paiements
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: header
 *         name: Idempotency-Key
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 8
 *           maxLength: 128
 *           example: 3f1c9a52-7d4e-4b8a-9c11-2e6f0b7a1d23
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - senderWalletId
 *               - amount
 *             properties:
 *               senderWalletId:
 *                 type: string
 *                 format: uuid
 *               receiverWalletId:
 *                 type: string
 *                 format: uuid
 *               recipientEmail:
 *                 type: string
 *                 format: email
 *                 example: bob@epsi.fr
 *               amount:
 *                 type: string
 *                 example: "49.99"
 *                 description: Montant positif, 2 décimales maximum, plafonné à 10000.00
 *               currency:
 *                 type: string
 *                 example: EUR
 *               description:
 *                 type: string
 *                 maxLength: 255
 *     responses:
 *       201:
 *         description: Paiement effectué
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payment:
 *                   $ref: '#/components/schemas/Payment'
 *       200:
 *         description: Rejeu d'une clé d'idempotence déjà traitée (aucun nouveau débit)
 *       400:
 *         description: Requête invalide (montant, identifiants, Idempotency-Key)
 *       401:
 *         description: Non authentifié
 *       403:
 *         description: Adresse IP bloquée ou compte suspendu
 *       404:
 *         description: Portefeuille émetteur ou destinataire introuvable (y compris e-mail inconnu)
 *       409:
 *         description: Clé d'idempotence réutilisée pour un autre paiement, ou conflit concurrent
 *       422:
 *         description: Solde insuffisant, portefeuille inactif ou devises différentes
 */
paymentRouter.post('/payments', requireAuth, requireActiveAccount, createPaymentHandler);

/**
 * @openapi
 * /payments/test-validation:
 *   post:
 *     summary: Paiement de validation post-incident (route interne)
 *     description: >
 *       Réservé au moteur de remédiation, **non exposé par la passerelle**. Émet un paiement
 *       `VALIDATION_TEST` de 0,01 entre deux comptes dédiés. Avec `incidentId`, la preuve
 *       (succès et durée) est enregistrée dans `remediation_logs`.
 *     tags:
 *       - Interne
 *     parameters:
 *       - in: header
 *         name: X-Internal-Token
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               incidentId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Paiement de validation réussi — la plateforme est opérationnelle
 *       401:
 *         description: Jeton interne invalide
 *       404:
 *         description: Incident introuvable
 *       503:
 *         description: Paiement de validation en échec, ou route désactivée
 */
paymentRouter.post('/payments/test-validation', requireInternalToken, testValidationHandler);

/**
 * @openapi
 * /payments/{id}:
 *   get:
 *     summary: Détail d'un paiement
 *     description: Visible uniquement par l'émetteur ou le destinataire ; sinon 404.
 *     tags:
 *       - Paiements
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Paiement
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 payment:
 *                   $ref: '#/components/schemas/Payment'
 *       401:
 *         description: Non authentifié
 *       404:
 *         description: Paiement introuvable
 */
paymentRouter.get('/payments/:id', requireAuth, requireActiveAccount, getPaymentHandler);
