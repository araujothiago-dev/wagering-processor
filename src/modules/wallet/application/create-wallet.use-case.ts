// `wallet/application` — CreateWalletUseCase (Story 1.2).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { CreateWalletOpeningWrite, CreateWalletTransactionalWriter } from './ports';

export interface CreateWalletCommand {
  playerId: string;
  currency: string;
  initialBalance?: string;
}

export class CreateWalletUseCase {
  constructor(private readonly writer: CreateWalletTransactionalWriter) {}

  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const wallet = Wallet.open(command.playerId, command.currency, command.initialBalance);
    const opening = this.buildOpening(wallet);

    await this.writer.write({ wallet, opening });

    return wallet;
  }

  private buildOpening(wallet: Wallet): CreateWalletOpeningWrite | undefined {
    const zero = Money.zero(wallet.currency);
    if (wallet.balance.equals(zero)) {
      return undefined;
    }

    const wagerTransactionId = randomUUID();
    const ledgerEntry = WalletLedgerEntry.credit({
      walletId: wallet.id,
      wagerTransactionId,
      money: wallet.balance,
      balanceBefore: zero,
      balanceAfter: wallet.balance,
    });

    return {
      wagerTransactionId,
      ledgerEntry,
      outboxMessage: {
        type: 'WalletBalanceChanged',
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balanceBefore: ledgerEntry.balanceBefore.amount,
        balanceAfter: ledgerEntry.balanceAfter.amount,
        wagerTransactionId,
        occurredAt: new Date().toISOString(),
      },
    };
  }
}
