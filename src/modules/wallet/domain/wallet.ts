// `wallet/domain` — Wallet aggregate root (Story 1.2, ARCHITECTURE.md "Schema" / "Concorrência").
//
// Rule (AD-1/AD-2): this layer never imports NestJS, TypeORM, HTTP, or SQS — every balance
// transition happens inside these classes, never in a use case or a repository.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';
import { CurrencyMismatchError } from './errors';

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
}
