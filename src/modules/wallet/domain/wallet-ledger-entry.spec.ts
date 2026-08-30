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

  describe('debit', () => {
    it('records a valid DEBIT entry', () => {
      const entry = WalletLedgerEntry.debit({
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        money: Money.of('30.00', 'USD'),
        balanceBefore: Money.of('100.00', 'USD'),
        balanceAfter: Money.of('70.00', 'USD'),
      });

      expect(entry.direction).toBe('DEBIT');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.wagerTransactionId).toBe('tx-1');
      expect(entry.money.amount).toBe('30.00');
      expect(entry.balanceBefore.amount).toBe('100.00');
      expect(entry.balanceAfter.amount).toBe('70.00');
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
    });

    it('allows a debit that exactly exhausts the balance', () => {
      const entry = WalletLedgerEntry.debit({
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.of('50.00', 'USD'),
        balanceAfter: Money.zero('USD'),
      });

      expect(entry.balanceAfter.amount).toBe('0.00');
    });

    it('rejects an entry whose arithmetic does not add up', () => {
      const error = captureError(() =>
        WalletLedgerEntry.debit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('10.00', 'USD'),
          balanceBefore: Money.of('50.00', 'USD'),
          balanceAfter: Money.of('30.00', 'USD'),
        }),
      );

      expect(error).toBeInstanceOf(WalletLedgerEntryInvariantViolationError);
    });

    it('rejects an entry mixing currencies between money and balanceBefore', () => {
      const error = captureError(() =>
        WalletLedgerEntry.debit({
          walletId: 'wallet-1',
          wagerTransactionId: 'tx-1',
          money: Money.of('10.00', 'EUR'),
          balanceBefore: Money.of('50.00', 'USD'),
          balanceAfter: Money.of('40.00', 'USD'),
        }),
      );

      expect(error).toBeInstanceOf(MoneyCurrencyMismatchError);
    });
  });

  describe('rehydrate', () => {
    it('reconstructs a persisted entry exactly, field for field', () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z');

      const entry = WalletLedgerEntry.rehydrate({
        id: 'entry-1',
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        direction: 'CREDIT',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('50.00', 'USD'),
        createdAt,
      });

      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.wagerTransactionId).toBe('tx-1');
      expect(entry.direction).toBe('CREDIT');
      expect(entry.money.amount).toBe('50.00');
      expect(entry.balanceBefore.amount).toBe('0.00');
      expect(entry.balanceAfter.amount).toBe('50.00');
      expect(entry.createdAt).toBe(createdAt);
    });

    it('never re-runs the balanceBefore ± money === balanceAfter invariant check', () => {
      // credit() would reject this arithmetic; rehydrate() must not — a row already made it
      // into `wallet_ledger_entries` and is trusted as-is, same philosophy as Wallet.rehydrate.
      const entry = WalletLedgerEntry.rehydrate({
        id: 'entry-1',
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        direction: 'CREDIT',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('40.00', 'USD'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(entry.balanceAfter.amount).toBe('40.00');
    });

    it('reconstructs a DEBIT entry (vocabulary already declared, not produced by credit())', () => {
      const entry = WalletLedgerEntry.rehydrate({
        id: 'entry-1',
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        direction: 'DEBIT',
        money: Money.of('10.00', 'USD'),
        balanceBefore: Money.of('50.00', 'USD'),
        balanceAfter: Money.of('40.00', 'USD'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(entry.direction).toBe('DEBIT');
    });
  });
});
