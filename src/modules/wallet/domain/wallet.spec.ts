import { describe, expect, it } from 'bun:test';
import { Money, MoneyValidationError } from '../../../shared/money';
import { CurrencyMismatchError, InsufficientBalanceError } from './errors';
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

  describe('applyDebit', () => {
    it('returns a new Wallet with the balance decremented and version incremented', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('100.00', 'USD'),
        version: 3,
      });

      const debited = wallet.applyDebit(Money.of('30.00', 'USD'));

      expect(debited.balance.amount).toBe('70.00');
      expect(debited.version).toBe(4);
      expect(debited.id).toBe('wallet-1');
      expect(debited).not.toBe(wallet);
    });

    it('never mutates the original wallet', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('100.00', 'USD'),
        version: 1,
      });

      wallet.applyDebit(Money.of('30.00', 'USD'));

      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('allows a debit that exactly exhausts the balance', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('50.00', 'USD'),
        version: 1,
      });

      const debited = wallet.applyDebit(Money.of('50.00', 'USD'));

      expect(debited.balance.amount).toBe('0.00');
      expect(debited.version).toBe(2);
    });

    it('rejects a debit larger than the balance with InsufficientBalanceError', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('30.00', 'USD'),
        version: 1,
      });

      const error = captureError(() => wallet.applyDebit(Money.of('100.00', 'USD')));

      expect(error).toBeInstanceOf(InsufficientBalanceError);
      expect((error as InsufficientBalanceError).code).toBe('INSUFFICIENT_BALANCE');
      // Balance/version must stay untouched — a thrown error means no state change happened.
      expect(wallet.balance.amount).toBe('30.00');
      expect(wallet.version).toBe(1);
    });

    it('rejects a debit in a different currency with CurrencyMismatchError, before checking sufficiency', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('0.00', 'USD'),
        version: 1,
      });

      const error = captureError(() => wallet.applyDebit(Money.of('10.00', 'EUR')));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
    });
  });

  describe('applyCredit', () => {
    it('returns a new Wallet with the balance incremented and version incremented', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('100.00', 'USD'),
        version: 3,
      });

      const credited = wallet.applyCredit(Money.of('30.00', 'USD'));

      expect(credited.balance.amount).toBe('130.00');
      expect(credited.version).toBe(4);
      expect(credited.id).toBe('wallet-1');
      expect(credited).not.toBe(wallet);
    });

    it('never mutates the original wallet', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('100.00', 'USD'),
        version: 1,
      });

      wallet.applyCredit(Money.of('30.00', 'USD'));

      expect(wallet.balance.amount).toBe('100.00');
      expect(wallet.version).toBe(1);
    });

    it('never fails on the wallet balance itself — a credit always succeeds when currency matches', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('0.00', 'USD'),
        version: 1,
      });

      const credited = wallet.applyCredit(Money.of('1000000.00', 'USD'));

      expect(credited.balance.amount).toBe('1000000.00');
    });

    it('rejects a credit in a different currency with CurrencyMismatchError', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('0.00', 'USD'),
        version: 1,
      });

      const error = captureError(() => wallet.applyCredit(Money.of('10.00', 'EUR')));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
    });
  });
});
