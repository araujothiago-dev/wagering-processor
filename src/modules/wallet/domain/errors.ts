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

// Story 1.3 — distinct from `VALIDATION_INVALID_WALLET_ID` (malformed request, never reaches a
// query): this is a syntactically valid walletId that simply has no row.
export class WalletNotFoundError extends Error {
  readonly code = 'WALLET_NOT_FOUND' as const;

  constructor(walletId: string) {
    super(`No wallet found with id '${walletId}'.`);
    this.name = 'WalletNotFoundError';
  }
}
