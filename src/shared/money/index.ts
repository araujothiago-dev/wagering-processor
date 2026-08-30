// `shared/money` — Money value object (Story 1.2, ARCHITECTURE.md "Money e persistência").
//
// Rule (AD-2/AD-8): this layer never imports NestJS, TypeORM, or any other infrastructure SDK —
// only `decimal.js`, a pure calculation library. Amounts are always fixed-scale decimal strings,
// never `number`/`float`/`double`.
import { Decimal } from 'decimal.js';

// Isolated constructor so this module's rounding/precision never leaks into (or is affected by)
// any other `decimal.js` usage elsewhere in the process.
const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const SCALE = 2;
const DECIMAL_SHAPE = /^-?\d+(\.\d+)?$/;

export type MoneyValidationErrorCode =
  | 'VALIDATION_EMPTY_AMOUNT'
  | 'VALIDATION_INVALID_FORMAT'
  | 'VALIDATION_TOO_MANY_DECIMALS'
  | 'VALIDATION_NEGATIVE_AMOUNT';

export class MoneyValidationError extends Error {
  readonly code: MoneyValidationErrorCode;

  constructor(code: MoneyValidationErrorCode, message: string) {
    super(message);
    this.name = 'MoneyValidationError';
    this.code = code;
  }
}

export class MoneyCurrencyMismatchError extends Error {
  readonly code = 'CURRENCY_MISMATCH' as const;

  constructor(left: string, right: string) {
    super(`Cannot operate on Money with different currencies: '${left}' and '${right}'.`);
    this.name = 'MoneyCurrencyMismatchError';
  }
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    private readonly currencyCode: string,
  ) {}

  static of(amount: string, currency: string): Money {
    if (amount === '') {
      throw new MoneyValidationError('VALIDATION_EMPTY_AMOUNT', 'Money amount must not be empty.');
    }

    if (!DECIMAL_SHAPE.test(amount)) {
      throw new MoneyValidationError(
        'VALIDATION_INVALID_FORMAT',
        `Money amount '${amount}' is not a plain decimal string.`,
      );
    }

    const fractional = amount.split('.')[1] ?? '';
    if (fractional.length > SCALE) {
      throw new MoneyValidationError(
        'VALIDATION_TOO_MANY_DECIMALS',
        `Money amount '${amount}' has more than ${SCALE} decimal places.`,
      );
    }

    if (amount.startsWith('-')) {
      throw new MoneyValidationError(
        'VALIDATION_NEGATIVE_AMOUNT',
        `Money amount '${amount}' must not be negative.`,
      );
    }

    return new Money(new MoneyDecimal(amount).toDecimalPlaces(SCALE), currency);
  }

  static zero(currency: string): Money {
    return new Money(new MoneyDecimal(0).toDecimalPlaces(SCALE), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value).toDecimalPlaces(SCALE), this.currencyCode);
  }

  // Story 2.1 — defense in depth (spec "Code Map"): `Wallet.applyDebit` already checks
  // sufficiency (`isLessThan`) before ever calling this, so this guard should never actually
  // trigger in the debit path. It exists so `subtract` is never a silent source of a negative
  // `Money` if some other future call site forgets that check.
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.minus(other.value).toDecimalPlaces(SCALE);

    if (result.isNegative()) {
      throw new MoneyValidationError(
        'VALIDATION_NEGATIVE_AMOUNT',
        `Money subtraction would produce a negative amount: ${this.amount} - ${other.amount}.`,
      );
    }

    return new Money(result, this.currencyCode);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currencyCode === other.currencyCode && this.value.equals(other.value);
  }

  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  get currency(): string {
    return this.currencyCode;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currencyCode !== other.currencyCode) {
      throw new MoneyCurrencyMismatchError(this.currencyCode, other.currencyCode);
    }
  }
}
