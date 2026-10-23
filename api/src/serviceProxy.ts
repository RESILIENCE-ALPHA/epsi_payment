import { Request, Response, NextFunction, RequestHandler } from 'express';
import { Readable } from 'stream';

// En-têtes propres à une connexion TCP : ils ne doivent jamais être relayés tels quels
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

// fetch décompresse la réponse : l'encodage d'origine ne correspond plus au corps relayé
const STRIPPED_RESPONSE_HEADERS = new Set([...HOP_BY_HOP_HEADERS, 'content-encoding']);

/**
 * Traduit TRUST_PROXY en valeur du réglage Express `trust proxy` de la passerelle.
 *
 * C'est le nombre de proxys de confiance DEVANT la passerelle. Par défaut 0 : l'IP cliente est
 * l'adresse de la socket et tout X-Forwarded-For reçu est ignoré.
 * Compose : 1 (nginx du front) ; Kubernetes : 2 (Ingress + nginx du front).
 * Accepte aussi "true" / "false" ou une liste de sous-réseaux.
 */
export function parseTrustProxy(value: string | undefined): number | boolean | string {
  if (value === undefined || value.trim() === '') return 0;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

/** IP cliente résolue par Express selon `trust proxy` (forme IPv4 pour les adresses ::ffff:a.b.c.d) */
export function resolveClientIp(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

/** Route publique autorisée à traverser la passerelle (chemin complet, segments `:param` acceptés) */
export interface PublicRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Vrai si la requête correspond à l'une des routes déclarées (ex: /payments/:id ↔ /payments/42) */
export function isPublicRoute(routes: PublicRoute[], method: string, path: string): boolean {
  const requestSegments = splitPath(path);
  return routes.some((route) => {
    if (route.method !== method) return false;
    const routeSegments = splitPath(route.path);
    return (
      routeSegments.length === requestSegments.length &&
      routeSegments.every((segment, i) => segment.startsWith(':') || segment === requestSegments[i])
    );
  });
}

export interface ServiceProxyOptions {
  /** Nom logique du service cible (utilisé dans les logs et les erreurs) */
  serviceName: string;
  /** URL de base du service cible, ex: http://auth:3001 */
  baseUrl: string;
  /** Délai maximal avant de considérer le service comme indisponible */
  timeoutMs: number;
  /** Liste blanche : toute autre route du service reste interne et répond 404 */
  routes: PublicRoute[];
}

/**
 * Reverse proxy minimaliste vers un service interne.
 *
 * Seules les routes déclarées dans `routes` sont relayées : une route ajoutée dans un service
 * (admin, inter-services, sonde…) ne devient pas publique par accident. Les autres requêtes
 * passent au middleware suivant (404 de la passerelle).
 *
 * Doit être monté AVANT express.json() : le corps de la requête est relayé en flux brut.
 * En cas de panne du service cible, l'API répond 503 (injoignable) ou 504 (timeout)
 * au lieu de rester bloquée — le reste de la plateforme continue de fonctionner.
 */
export function createServiceProxy({ serviceName, baseUrl, timeoutMs, routes }: ServiceProxyOptions): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!isPublicRoute(routes, req.method, req.baseUrl + req.path)) {
      next();
      return;
    }

    const target = new URL(req.originalUrl, baseUrl);

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }

    // La passerelle est la frontière de confiance : elle résout l'IP cliente (selon son propre
    // `trust proxy`) et la transmet seule. Les services internes n'ont qu'un saut à croire,
    // quel que soit le nombre de proxys devant la passerelle, et une valeur forgée ne passe pas.
    headers.set('x-forwarded-for', resolveClientIp(req));
    headers.set('x-forwarded-host', req.headers.host ?? '');
    headers.set('x-forwarded-proto', req.protocol);

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';

    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        // Requis par undici pour envoyer un corps en flux
        duplex: 'half',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);

      res.status(upstream.status);
      upstream.headers.forEach((value, name) => {
        if (!STRIPPED_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
      });
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      console.error(`[API Gateway] ${serviceName} ${isTimeout ? 'timeout' : 'unreachable'}:`, error);

      res.status(isTimeout ? 504 : 503).json({
        error: isTimeout ? 'GATEWAY_TIMEOUT' : 'SERVICE_UNAVAILABLE',
        message: `Le service ${serviceName} est momentanément indisponible.`,
        service: serviceName,
        timestamp: new Date().toISOString(),
      });
    }
  };
}
