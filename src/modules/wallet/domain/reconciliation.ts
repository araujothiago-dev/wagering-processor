// `wallet/domain` — reconciliation (Story 4.2). Pure computation: replays every
// `WalletLedgerEntry` for a wallet from `"0.00"` and compares the result against the wallet's
// currently stored balance. Never corrects anything — divergences are reported, not fixed
// silently (README §9 "Reconciliação").
//
// Rule (AD-1/AD-2): this layer never imports NestJS, TypeORM, HTTP, or SQS.
import { Money } from '../../../shared/money';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface ReconciliationResult {
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

// Entries must replay in the order they actually happened — `Money` never goes negative, so an
// out-of-order fold (a DEBIT applied before the CREDIT it depends on) would throw instead of
// reporting a divergence. `createdAt`/`id` is the same keyset ordering the ledger endpoint
// (Story 1.3) already uses for exactly this reason.
function sortChronologically(entries: WalletLedgerEntry[]): WalletLedgerEntry[] {
  return [...entries].sort((a, b) => {
    const byTime = a.createdAt.getTime() - b.createdAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}

export function reconcileWalletBalance(
  storedBalance: Money,
  ledgerEntries: WalletLedgerEntry[],
): ReconciliationResult {
  const currency = storedBalance.currency;
  const ordered = sortChronologically(ledgerEntries);

  let calculatedBalance = Money.zero(currency);
  for (const entry of ordered) {
    calculatedBalance =
      entry.direction === 'CREDIT' ? calculatedBalance.add(entry.money) : calculatedBalance.subtract(entry.money);
  }

  const consistent = calculatedBalance.equals(storedBalance);
  const difference = consistent
    ? Money.zero(currency)
    : calculatedBalance.isLessThan(storedBalance)
      ? storedBalance.subtract(calculatedBalance)
      : calculatedBalance.subtract(storedBalance);

  return {
    storedBalance,
    calculatedBalance,
    difference,
    consistent,
    checkedEntries: ledgerEntries.length,
  };
}
