// `wallet/domain` — Wallet aggregate root (Story 1.2, ARCHITECTURE.md "Schema" / "Concorrência").
//
// Rule (AD-1/AD-2): this layer never imports NestJS, TypeORM, HTTP, or SQS — every balance
// transition happens inside these classes, never in a use case or a repository.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';
import { CurrencyMismatchError, InsufficientBalanceError } from './errors';

export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    readonly balance: Money,
    readonly version: number,
  ) {}

  static open(playerId: string, currency: string, initialBalance?: string): Wallet {
    const balance =
      initialBalance === undefined ? Money.zero(currency) : Money.of(initialBalance, currency);

    return new Wallet(randomUUID(), playerId, currency, balance, 1);
  }

  static rehydrate(params: {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
  }): Wallet {
    return new Wallet(params.id, params.playerId, params.currency, params.balance, params.version);
  }

  assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  // Story 2.1 — applies a `BET` debit. Immutable: returns a new `Wallet` instance with the
  // balance decremented and `version` incremented; never mutates `this`. Currency is checked
  // first (spec "Moeda da BET deve bater com a da wallet ... antes de qualquer débito"), then
  // sufficiency — `InsufficientBalanceError` propagates to the caller (`SubmitBetUseCase`'s
  // `decide` closure), which is the one place that turns it into a persisted `REJECTED`
  // transaction instead of letting it abort the whole SQL transaction like a currency mismatch
  // does.
  applyDebit(money: Money): Wallet {
    this.assertSameCurrency(money);

    if (this.balance.isLessThan(money)) {
      throw new InsufficientBalanceError(this.id, money);
    }

    return new Wallet(this.id, this.playerId, this.currency, this.balance.subtract(money), this.version + 1);
  }

  // Story 2.2 — applies a `WIN` credit. Mirrors `applyDebit`: immutable, currency-checked first
  // via `assertSameCurrency`. No sufficiency check — a credit only ever increases the balance, so
  // there is nothing to reject (unlike `applyDebit`, this never throws `InsufficientBalanceError`).
  applyCredit(money: Money): Wallet {
    this.assertSameCurrency(money);

    return new Wallet(this.id, this.playerId, this.currency, this.balance.add(money), this.version + 1);
  }
}
