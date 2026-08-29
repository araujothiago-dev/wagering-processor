// `wallet/domain` errors (Story 1.2). Pure domain errors — no NestJS/HTTP mapping here (AD-1/AD-2);
// `shared/http` maps `code` to an HTTP status at the boundary.

export class CurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH' as const;

  constructor(walletCurrency: string, moneyCurrency: string) {
    super(`Wallet currency '${walletCurrency}' does not match money currency '${moneyCurrency}'.`);
    this.name = 'CurrencyMismatchError';
  }
}

export class WalletAlreadyExistsError extends Error {
  readonly code = 'WALLET_ALREADY_EXISTS' as const;

  constructor(playerId: string, currency: string) {
    super(`A wallet already exists for player '${playerId}' in currency '${currency}'.`);
    this.name = 'WalletAlreadyExistsError';
  }
}
