// `wallet/infrastructure` — CreateWalletTransactionalWriter (Story 1.2, ARCHITECTURE.md
// "Outbox transacional").
//
// Writes wallet + (when present) the OPENING wager_transaction row, the wallet_ledger_entries
// row, and the outbox_messages row through one explicit `QueryRunner` transaction — never
// `Repository.save()` — and translates the `wallets(player_id, currency)` unique violation into
// `WalletAlreadyExistsError`, detected only by the insert failing (never by a prior read).
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, type QueryRunner } from 'typeorm';
import { WalletAlreadyExistsError } from '../domain/errors';
import type { Wallet } from '../domain/wallet';
import type { CreateWalletOpeningWrite, CreateWalletTransactionalWriter, CreateWalletWriteCommand } from '../application/ports';
import { OutboxMessageEntity } from './outbox-message.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';
import { WALLET_PLAYER_CURRENCY_UNIQUE_CONSTRAINT, WalletEntity } from './wallet.entity';

function isWalletUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error as unknown as { code?: string; constraint?: string };
  return driverError.code === '23505' && driverError.constraint === WALLET_PLAYER_CURRENCY_UNIQUE_CONSTRAINT;
}

@Injectable()
export class CreateWalletTransactionalWriterImpl implements CreateWalletTransactionalWriter {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async write(command: CreateWalletWriteCommand): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.insertWallet(queryRunner, command.wallet);

      if (command.opening) {
        await this.insertOpening(queryRunner, command.wallet.id, command.opening);
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (isWalletUniqueViolation(error)) {
        throw new WalletAlreadyExistsError(command.wallet.playerId, command.wallet.currency);
      }

      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async insertWallet(queryRunner: QueryRunner, wallet: Wallet): Promise<void> {
    await queryRunner.manager.insert(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.amount,
      version: wallet.version,
    });
  }

  private async insertOpening(
    queryRunner: QueryRunner,
    walletId: string,
    opening: CreateWalletOpeningWrite,
  ): Promise<void> {
    const { ledgerEntry, wagerTransactionId, outboxMessage } = opening;

    await queryRunner.manager.insert(WagerTransactionEntity, {
      id: wagerTransactionId,
      walletId,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: ledgerEntry.money.amount,
      idempotencyKey: null,
      referenceTransactionId: null,
    });

    await queryRunner.manager.insert(WalletLedgerEntryEntity, {
      id: ledgerEntry.id,
      walletId: ledgerEntry.walletId,
      wagerTransactionId: ledgerEntry.wagerTransactionId,
      direction: ledgerEntry.direction,
      amount: ledgerEntry.money.amount,
      balanceBefore: ledgerEntry.balanceBefore.amount,
      balanceAfter: ledgerEntry.balanceAfter.amount,
    });

    await queryRunner.manager.insert(OutboxMessageEntity, {
      id: randomUUID(),
      type: outboxMessage.type,
      payload: outboxMessage,
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
  }
}
