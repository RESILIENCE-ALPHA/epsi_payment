import path from 'path';
import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'EPSI Pay Auth',
      version: '1.0.0',
      description:
        'Service d\'authentification de la plateforme EPSI Pay — Projet RESILIENCE-ALPHA.\n\n' +
        'Sessions Bearer, protection brute force et filtrage des IP bloquées.',
      contact: {
        name: 'Équipe EPSI Pay',
      },
    },
    // URL relative : la spec est utilisable aussi bien via la passerelle API qu'en direct
    servers: [
      {
        url: '/',
        description: 'Hôte courant (passerelle API ou service auth)',
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
        UserProfile: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', example: 'd4b7c62e-8a1f-4c8d-9b3e-1f2a3b4c5d6e' },
            email: { type: 'string', format: 'email', example: 'alice@epsi.fr' },
            name: { type: 'string', example: 'Alice Martin' },
            role: { type: 'string', enum: ['CLIENT', 'MERCHANT', 'ADMIN'], example: 'CLIENT' },
            status: { type: 'string', enum: ['ACTIVE', 'LOCKED', 'SUSPENDED'], example: 'ACTIVE' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  // Résolu depuis l'emplacement du fichier : src/*.ts en dev, dist/src/*.js dans l'image Docker
  apis: [path.join(__dirname, '*.{ts,js}')],
};

export const swaggerSpec = swaggerJsdoc(options);
