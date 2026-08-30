import { describe, expect, it } from 'bun:test';
import { Money } from '../../../shared/money';
import { reconcileWalletBalance } from './reconciliation';
import { WalletLedgerEntry } from './wallet-ledger-entry';

describe('reconcileWalletBalance', () => {
  describe('when the ledger sums to the stored balance', () => {
    it('reports consistent=true with a "0.00" difference', () => {
      const entries = [
        WalletLedgerEntry.rehydrate({
          id: 'entry-1',
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          direction: 'CREDIT',
          money: Money.of('50.00', 'USD'),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.of('50.00', 'USD'),
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        WalletLedgerEntry.rehydrate({
          id: 'entry-2',
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-2',
          direction: 'DEBIT',
          money: Money.of('20.00', 'USD'),
          balanceBefore: Money.of('50.00', 'USD'),
          balanceAfter: Money.of('30.00', 'USD'),
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        }),
      ];

      const result = reconcileWalletBalance(Money.of('30.00', 'USD'), entries);

      expect(result.consistent).toBe(true);
      expect(result.difference.amount).toBe('0.00');
      expect(result.calculatedBalance.amount).toBe('30.00');
      expect(result.storedBalance.amount).toBe('30.00');
      expect(result.checkedEntries).toBe(2);
    });

    it('is order-independent — sorts entries chronologically before folding', () => {
      const older = WalletLedgerEntry.rehydrate({
        id: 'entry-older',
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        direction: 'CREDIT',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('50.00', 'USD'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const newer = WalletLedgerEntry.rehydrate({
        id: 'entry-newer',
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-2',
        direction: 'DEBIT',
        money: Money.of('20.00', 'USD'),
        balanceBefore: Money.of('50.00', 'USD'),
        balanceAfter: Money.of('30.00', 'USD'),
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      // Passed in reverse chronological order — folding naively (CREDIT then a bigger DEBIT
      // arriving "first") would otherwise blow up subtracting past zero.
      const result = reconcileWalletBalance(Money.of('30.00', 'USD'), [newer, older]);

      expect(result.consistent).toBe(true);
      expect(result.calculatedBalance.amount).toBe('30.00');
    });
  });

  describe('when the ledger does not sum to the stored balance', () => {
    it('reports consistent=false with the absolute difference, without correcting anything', () => {
      // Manually constructed to diverge from the stored balance — never produced by the real
      // use case flow, which is exactly the scenario reconciliation exists to catch.
      const entries = [
        WalletLedgerEntry.credit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('50.00', 'USD'),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.of('50.00', 'USD'),
        }),
      ];

      const result = reconcileWalletBalance(Money.of('80.00', 'USD'), entries);

      expect(result.consistent).toBe(false);
      expect(result.difference.amount).toBe('30.00');
      expect(result.calculatedBalance.amount).toBe('50.00');
      expect(result.storedBalance.amount).toBe('80.00');
      expect(result.checkedEntries).toBe(1);
    });

    it('reports the same absolute difference when the calculated balance exceeds the stored one', () => {
      const entries = [
        WalletLedgerEntry.credit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('50.00', 'USD'),
          balanceBefore: Money.zero('USD'),
          balanceAfter: Money.of('50.00', 'USD'),
        }),
      ];

      const result = reconcileWalletBalance(Money.of('10.00', 'USD'), entries);

      expect(result.consistent).toBe(false);
      expect(result.difference.amount).toBe('40.00');
    });
  });

  describe('when there are no ledger entries', () => {
    it('treats an empty ledger as a zero calculated balance', () => {
      const result = reconcileWalletBalance(Money.zero('USD'), []);

      expect(result.consistent).toBe(true);
      expect(result.checkedEntries).toBe(0);
    });
  });
});
