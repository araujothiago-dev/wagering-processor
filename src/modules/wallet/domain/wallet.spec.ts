import { describe, expect, it } from 'bun:test';
import { Money, MoneyValidationError } from '../../../shared/money';
import { CurrencyMismatchError } from './errors';
import { Wallet } from './wallet';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Wallet', () => {
  describe('open — without initial balance', () => {
    it('opens with a "0.00" balance, version 1, and a generated id', () => {
      const wallet = Wallet.open('player-1', 'USD');

      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('USD');
      expect(wallet.balance.amount).toBe('0.00');
      expect(wallet.balance.currency).toBe('USD');
      expect(wallet.version).toBe(1);
      expect(typeof wallet.id).toBe('string');
      expect(wallet.id.length).toBeGreaterThan(0);
    });

    it('generates a different id for each wallet', () => {
      const first = Wallet.open('player-1', 'USD');
      const second = Wallet.open('player-1', 'USD');
      expect(first.id).not.toBe(second.id);
    });
  });

  describe('open — with initial balance', () => {
    it('opens with the given balance and version 1', () => {
      const wallet = Wallet.open('player-1', 'USD', '50.00');

      expect(wallet.balance.amount).toBe('50.00');
      expect(wallet.balance.currency).toBe('USD');
      expect(wallet.version).toBe(1);
    });

    it('propagates Money validation errors for an invalid initial balance', () => {
      const error = captureError(() => Wallet.open('player-1', 'USD', '-1.00'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_NEGATIVE_AMOUNT');
    });
  });

  describe('rehydrate', () => {
    it('reconstructs a wallet from a persisted snapshot, preserving its version', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('123.45', 'USD'),
        version: 7,
      });

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('USD');
      expect(wallet.balance.amount).toBe('123.45');
      expect(wallet.version).toBe(7);
    });
  });

  describe('assertSameCurrency', () => {
    it('does not throw when the currencies match', () => {
      const wallet = Wallet.open('player-1', 'USD');
      expect(() => wallet.assertSameCurrency(Money.of('10.00', 'USD'))).not.toThrow();
    });

    it('rejects money in a different currency', () => {
      const wallet = Wallet.open('player-1', 'USD');
      const error = captureError(() => wallet.assertSameCurrency(Money.of('10.00', 'EUR')));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    });
  });
});
