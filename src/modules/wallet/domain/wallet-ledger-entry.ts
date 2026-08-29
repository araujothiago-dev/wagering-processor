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
    );
  }
}
