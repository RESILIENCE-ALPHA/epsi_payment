import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'EPSI Pay Payment',
      version: '1.0.0',
      description:
        'Service de paiement de la plateforme EPSI Pay — Projet RESILIENCE-ALPHA.\n\n' +
        'Portefeuilles, paiements idempotents et paiement de validation post-incident.',
      contact: {
        name: 'Équipe EPSI Pay',
      },
    },
    // URL relative : la spec est utilisable aussi bien via la passerelle API qu'en direct
    servers: [
      {
        url: '/',
        description: 'Hôte courant (passerelle API ou service payment)',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Token',
          description: 'Entrez le jeton de session obtenu lors de l\'appel à /auth/login',
        },
      },
      schemas: {
        Wallet: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            currency: { type: 'string', example: 'EUR' },
            balance: { type: 'string', example: '1500.00' },
            status: { type: 'string', enum: ['ACTIVE', 'FROZEN', 'CLOSED'], example: 'ACTIVE' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        Payment: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            reference: { type: 'string', example: 'cm2x7k3p00001' },
            type: { type: 'string', enum: ['PAYMENT', 'TRANSFER', 'REFUND', 'VALIDATION_TEST'] },
            status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'FAILED', 'BLOCKED'] },
            amount: { type: 'string', example: '49.99' },
            currency: { type: 'string', example: 'EUR' },
            description: { type: 'string', nullable: true },
            senderWalletId: { type: 'string', format: 'uuid', nullable: true },
            receiverWalletId: { type: 'string', format: 'uuid' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        HistoryEntry: {
          allOf: [
            { $ref: '#/components/schemas/Payment' },
            {
              type: 'object',
              properties: {
                direction: { type: 'string', enum: ['DEBIT', 'CREDIT'], description: 'Sens du mouvement pour le portefeuille consulté' },
                counterparty: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    name: { type: 'string', nullable: true, example: 'Bob' },
                    email: { type: 'string', example: 'bob@epsi.fr' },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  // Résolu depuis l'emplacement du fichier : src/*.ts en dev, dist/src/*.js dans l'image Docker
  apis: [path.join(__dirname, '*.{ts,js}')],
};

export const swaggerSpec = swaggerJsdoc(options);
