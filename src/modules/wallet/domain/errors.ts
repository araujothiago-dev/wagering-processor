// `wallet/domain` errors (Story 1.2, extended Story 2.1). Pure domain errors — no NestJS/HTTP
// mapping here (AD-1/AD-2); `shared/http` maps `code` to an HTTP status at the boundary.
import type { Money } from '../../../shared/money';

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

// Story 2.1 — thrown by `Wallet.applyDebit` when `balance.isLessThan(requested)`. Caught inside
// `SubmitBetUseCase`'s `decide` closure and turned into a persisted `REJECTED` wager_transaction
// (spec "Rejeição comitada, erro HTTP retornado"); re-thrown by the use case after commit so the
// controller still surfaces `422 INSUFFICIENT_BALANCE` even though nothing was rolled back.
export class InsufficientBalanceError extends Error {
  readonly code = 'INSUFFICIENT_BALANCE' as const;

  constructor(walletId: string, requested: Money) {
    super(
      `Wallet '${walletId}' has insufficient balance for a debit of ${requested.amount} ${requested.currency}.`,
    );
    this.name = 'InsufficientBalanceError';
  }
}
