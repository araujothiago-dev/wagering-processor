import { describe, expect, it } from 'bun:test';
import { Money, MoneyCurrencyMismatchError, MoneyValidationError } from './index';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Money', () => {
  describe('of — invalid amounts', () => {
    it('rejects an empty string', () => {
      const error = captureError(() => Money.of('', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_EMPTY_AMOUNT');
    });

    it('rejects scientific notation ("1e5")', () => {
      const error = captureError(() => Money.of('1e5', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_INVALID_FORMAT');
    });

    it('rejects more than 2 decimal places ("1.234")', () => {
      const error = captureError(() => Money.of('1.234', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_TOO_MANY_DECIMALS');
    });

    it('rejects a negative amount ("-1.00")', () => {
      const error = captureError(() => Money.of('-1.00', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_NEGATIVE_AMOUNT');
    });

    it('rejects the literal string "NaN"', () => {
      const error = captureError(() => Money.of('NaN', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_INVALID_FORMAT');
    });

    it('rejects the literal string "Infinity"', () => {
      const error = captureError(() => Money.of('Infinity', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_INVALID_FORMAT');
    });

    it('rejects the literal string "-Infinity"', () => {
      const error = captureError(() => Money.of('-Infinity', 'USD'));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_INVALID_FORMAT');
    });
  });

  describe('of — valid amounts', () => {
    it('accepts an integer amount and normalizes it to 2 decimal places', () => {
      const money = Money.of('50', 'USD');
      expect(money.amount).toBe('50.00');
      expect(money.currency).toBe('USD');
    });

    it('accepts an amount with exactly 2 decimal places', () => {
      const money = Money.of('50.50', 'USD');
      expect(money.amount).toBe('50.50');
    });

    it('accepts "0.00"', () => {
      const money = Money.of('0.00', 'USD');
      expect(money.amount).toBe('0.00');
    });
  });

  describe('zero', () => {
    it('builds a "0.00" amount for the given currency', () => {
      const money = Money.zero('USD');
      expect(money.amount).toBe('0.00');
      expect(money.currency).toBe('USD');
    });
  });

  describe('add', () => {
    it('sums two amounts in the same currency', () => {
      const sum = Money.of('10.00', 'USD').add(Money.of('5.25', 'USD'));
      expect(sum.amount).toBe('15.25');
      expect(sum.currency).toBe('USD');
    });

    it('rejects summing amounts in different currencies', () => {
      const error = captureError(() => Money.of('10.00', 'USD').add(Money.of('5.00', 'EUR')));
      expect(error).toBeInstanceOf(MoneyCurrencyMismatchError);
      expect((error as MoneyCurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    });
  });

  describe('subtract', () => {
    it('subtracts two amounts in the same currency', () => {
      const diff = Money.of('10.00', 'USD').subtract(Money.of('4.25', 'USD'));
      expect(diff.amount).toBe('5.75');
      expect(diff.currency).toBe('USD');
    });

    it('allows the result to reach exactly zero', () => {
      const diff = Money.of('10.00', 'USD').subtract(Money.of('10.00', 'USD'));
      expect(diff.amount).toBe('0.00');
    });

    it('rejects subtracting amounts in different currencies', () => {
      const error = captureError(() => Money.of('10.00', 'USD').subtract(Money.of('5.00', 'EUR')));
      expect(error).toBeInstanceOf(MoneyCurrencyMismatchError);
      expect((error as MoneyCurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    });

    it('rejects a subtraction that would produce a negative amount', () => {
      const error = captureError(() => Money.of('5.00', 'USD').subtract(Money.of('10.00', 'USD')));
      expect(error).toBeInstanceOf(MoneyValidationError);
      expect((error as MoneyValidationError).code).toBe('VALIDATION_NEGATIVE_AMOUNT');
    });
  });

  describe('isLessThan', () => {
    it('is true when this amount is smaller', () => {
      expect(Money.of('5.00', 'USD').isLessThan(Money.of('10.00', 'USD'))).toBe(true);
    });

    it('is false when this amount is equal', () => {
      expect(Money.of('10.00', 'USD').isLessThan(Money.of('10.00', 'USD'))).toBe(false);
    });

    it('is false when this amount is larger', () => {
      expect(Money.of('10.00', 'USD').isLessThan(Money.of('5.00', 'USD'))).toBe(false);
    });

    it('rejects comparing amounts in different currencies', () => {
      const error = captureError(() => Money.of('5.00', 'USD').isLessThan(Money.of('10.00', 'EUR')));
      expect(error).toBeInstanceOf(MoneyCurrencyMismatchError);
    });
  });

  describe('equals', () => {
    it('is true for the same amount and currency', () => {
      expect(Money.of('10.00', 'USD').equals(Money.of('10.00', 'USD'))).toBe(true);
    });

    it('is false for a different amount', () => {
      expect(Money.of('10.00', 'USD').equals(Money.of('10.01', 'USD'))).toBe(false);
    });

    it('is false for a different currency', () => {
      expect(Money.of('10.00', 'USD').equals(Money.of('10.00', 'EUR'))).toBe(false);
    });
  });
});
