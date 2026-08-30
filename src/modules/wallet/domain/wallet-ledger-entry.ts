// `wallet/domain` — WalletLedgerEntry (Story 1.2, ARCHITECTURE.md "Ledger").
//
// Immutable by construction: there is no code path to mutate a value once built, mirroring the
// schema (no UPDATE/DELETE possible on `wallet_ledger_entries`). Every entry self-validates
// `balanceBefore ± money === balanceAfter` at construction time — it can never exist in an
// inconsistent state.
//
// `DEBIT` is part of the vocabulary already (matches `wager_transactions.kind` pre-declaring its
// full set in the migration, ARCHITECTURE.md "Design Notes") but this story only ever produces
// `CREDIT` entries (opening balance); generic debit application is Epic 2 scope.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';

export type WalletLedgerEntryDirection = 'CREDIT' | 'DEBIT';

export class WalletLedgerEntryInvariantViolationError extends Error {
  constructor(direction: WalletLedgerEntryDirection, balanceBefore: Money, money: Money, balanceAfter: Money) {
    super(
      `WalletLedgerEntry invariant violated: ${direction} of ${money.amount} ${money.currency} ` +
        `from ${balanceBefore.amount} does not reach ${balanceAfter.amount} ${balanceAfter.currency}.`,
    );
    this.name = 'WalletLedgerEntryInvariantViolationError';
  }
}

export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly wagerTransactionId: string,
    readonly direction: WalletLedgerEntryDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {}

  static credit(params: {
    walletId: string;
    wagerTransactionId: string;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
  }): WalletLedgerEntry {
    const { walletId, wagerTransactionId, money, balanceBefore, balanceAfter } = params;
    const expectedAfter = balanceBefore.add(money);

    if (!expectedAfter.equals(balanceAfter)) {
      throw new WalletLedgerEntryInvariantViolationError('CREDIT', balanceBefore, money, balanceAfter);
    }

    return new WalletLedgerEntry(
      randomUUID(),
      walletId,
      wagerTransactionId,
      'CREDIT',
      money,
      balanceBefore,
      balanceAfter,
      new Date(),
    );
  }

  // Story 2.1 — `BET` debit. Mirrors `credit()`'s self-validation, subtracting instead of
  // adding: `balanceBefore.subtract(money) === balanceAfter`.
  static debit(params: {
    walletId: string;
    wagerTransactionId: string;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
  }): WalletLedgerEntry {
    const { walletId, wagerTransactionId, money, balanceBefore, balanceAfter } = params;
    const expectedAfter = balanceBefore.subtract(money);

    if (!expectedAfter.equals(balanceAfter)) {
      throw new WalletLedgerEntryInvariantViolationError('DEBIT', balanceBefore, money, balanceAfter);
    }

    return new WalletLedgerEntry(
      randomUUID(),
      walletId,
      wagerTransactionId,
      'DEBIT',
      money,
      balanceBefore,
      balanceAfter,
      new Date(),
    );
  }

  // Story 1.3 — reconstructs a persisted row as-is, without re-running the `balanceBefore ±
  // money === balanceAfter` invariant check `credit()` performs. Mirrors `Wallet.rehydrate`: a
  // row that made it into `wallet_ledger_entries` was already validated once, at insert time.
  static rehydrate(params: {
    id: string;
    walletId: string;
    wagerTransactionId: string;
    direction: WalletLedgerEntryDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt: Date;
  }): WalletLedgerEntry {
    return new WalletLedgerEntry(
      params.id,
      params.walletId,
      params.wagerTransactionId,
      params.direction,
      params.money,
      params.balanceBefore,
      params.balanceAfter,
      params.createdAt,
    );
  }
}
