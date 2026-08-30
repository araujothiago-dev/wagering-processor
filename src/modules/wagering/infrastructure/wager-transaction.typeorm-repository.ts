// `wagering/infrastructure` — WagerTransactionTypeOrmRepository (Story 2.4).
//
// `wager_transactions` carries no `currency` column of its own (same pre-existing gap as
// `wallet_ledger_entries`, see deferred-work.md) — the wallet's *current* currency is looked up
// separately and used to reconstruct `Money`. Two round-trips, not a join: keeps this adapter
// simple, matches the pattern already used by `SubmitBetTransactionalWriterImpl`.
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Money } from '../../../shared/money';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { WagerTransactionEntity } from '../../wallet/infrastructure/wager-transaction.entity';
import { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionRepository } from '../application/ports';

@Injectable()
export class WagerTransactionTypeOrmRepository implements WagerTransactionRepository {
  constructor(
    @InjectRepository(WagerTransactionEntity)
    private readonly transactionRepository: Repository<WagerTransactionEntity>,
    @InjectRepository(WalletEntity)
    private readonly walletRepository: Repository<WalletEntity>,
  ) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const row = await this.transactionRepository.findOneBy({ id });
    return row ? this.toDomain(row) : null;
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const row = await this.transactionRepository.findOneBy({ providerId, externalTransactionId });
    return row ? this.toDomain(row) : null;
  }

  private async toDomain(row: WagerTransactionEntity): Promise<WagerTransaction> {
    const wallet = await this.walletRepository.findOneBy({ id: row.walletId });

    if (!wallet) {
      // Unreachable in practice: every wager_transactions row is written in the same SQL
      // transaction as its wallet, and wallets are never deleted.
      throw new Error(`Invariant violation: no wallet found for wager_transaction '${row.id}'.`);
    }

    return WagerTransaction.rehydrate({
      id: row.id,
      providerId: row.providerId ?? '',
      externalTransactionId: row.externalTransactionId ?? '',
      playerId: row.playerId ?? '',
      walletId: row.walletId,
      roundId: row.roundId ?? '',
      gameId: row.gameId ?? '',
      kind: row.kind,
      status: row.status,
      money: Money.of(row.amount, wallet.currency),
      idempotencyKey: row.idempotencyKey ?? '',
      payloadHash: row.payloadHash ?? '',
      failureCode: row.failureCode ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
    });
  }
}
