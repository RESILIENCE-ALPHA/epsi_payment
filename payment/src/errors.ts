/**
 * Erreur métier du service paiement : porte le statut HTTP et un code stable pour les clients
 */
export class PaymentError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}
