import { describe, expect, it } from 'bun:test';
import { Money, MoneyCurrencyMismatchError } from '../../../shared/money';
import { WalletLedgerEntry, WalletLedgerEntryInvariantViolationError } from './wallet-ledger-entry';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('WalletLedgerEntry', () => {
  describe('credit', () => {
    it('records a valid CREDIT entry', () => {
      const entry = WalletLedgerEntry.credit({
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('50.00', 'USD'),
      });

      expect(entry.direction).toBe('CREDIT');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.wagerTransactionId).toBe('tx-1');
      expect(entry.money.amount).toBe('50.00');
      expect(entry.balanceBefore.amount).toBe('0.00');
      expect(entry.balanceAfter.amount).toBe('50.00');
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
    });

    it('accumulates on top of a non-zero balanceBefore', () => {
      const entry = WalletLedgerEntry.credit({
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-2',
        money: Money.of('10.00', 'USD'),
        balanceBefore: Money.of('40.00', 'USD'),
        balanceAfter: Money.of('50.00', 'USD'),
      });

      expect(entry.balanceAfter.amount).toBe('50.00');
    });

    it('rejects an entry whose arithmetic does not add up', () => {
      const error = captureError(() =>
        WalletLedgerEntry.credit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('50.00', 'USD'),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.of('40.00', 'USD'),
        }),
      );

      expect(error).toBeInstanceOf(WalletLedgerEntryInvariantViolationError);
    });

    it('rejects an entry mixing currencies between money and balanceBefore', () => {
      const error = captureError(() =>
        WalletLedgerEntry.credit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('50.00', 'EUR'),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.of('50.00', 'USD'),
        }),
      );

      expect(error).toBeInstanceOf(MoneyCurrencyMismatchError);
    });

    it('rejects an entry whose balanceAfter currency does not match', () => {
      const error = captureError(() =>
        WalletLedgerEntry.credit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('50.00', 'USD'),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.of('50.00', 'EUR'),
        }),
      );

      expect(error).toBeInstanceOf(WalletLedgerEntryInvariantViolationError);
    });
  });
});
