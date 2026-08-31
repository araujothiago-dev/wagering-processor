// `wagering/infrastructure` — SubmitWagerTransactionalWriterImpl (Story 2.1, widened Story 2.2,
// ARCHITECTURE.md "Concorrência" / "Idempotência").
//
// Explicit `QueryRunner`, never `Repository.save()`. Lock order: wallet row `SELECT ... FOR
// UPDATE` first (blocking, no `NOWAIT`/`SKIP LOCKED`), then `decide()` runs pure domain logic
// with the locked wallet, then the speculative `wager_transactions` insert is guarded by a
// named `SAVEPOINT` issued as raw SQL (`queryRunner.query('SAVEPOINT ...')` /
// `'ROLLBACK TO SAVEPOINT ...'`) — deliberately never TypeORM's automatic nested-transaction
// savepoint (spec "Never" / ARCHITECTURE.md "Idempotência").
//
// One writer for every synchronous wager kind (BET/WIN/LOSS today) — not one per kind — because
// the lock+savepoint+idempotency mechanics are identical regardless of what `decide` computes;
// only `applyDecision`/`handleCollision` branch on whether the decision affects the balance.
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, type QueryRunner } from 'typeorm';
import { Money } from '../../../shared/money';
import { WalletNotFoundError } from '../../wallet/domain/errors';
import { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { OutboxMessageEntity } from '../../wallet/infrastructure/outbox-message.entity';
import { WagerTransactionEntity } from '../../wallet/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../wallet/infrastructure/wallet-ledger-entry.entity';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { IdempotencyKeyConflictError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import type {
  SubmitWagerDecide,
  SubmitWagerDecision,
  SubmitWagerOutcome,
  SubmitWagerTransactionalWriter,
} from '../application/ports';

const IDEMPOTENCY_KEY_UNIQUE_CONSTRAINT = 'UQ_wager_transactions_idempotency_key';
const SAVEPOINT_NAME = 'submit_wager_transaction_speculative_insert';

// `handleCollision`'s result — `CONFLICT` carries just enough to build
// `IdempotencyKeyConflictError` after the caller commits (see `submit`).
type CollisionResult =
  | { kind: 'OUTCOME'; outcome: SubmitWagerOutcome }
  | { kind: 'CONFLICT'; idempotencyKey: string };

function isIdempotencyKeyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error as unknown as { code?: string; constraint?: string };
  return driverError.code === '23505' && driverError.constraint === IDEMPOTENCY_KEY_UNIQUE_CONSTRAINT;
}

@Injectable()
export class SubmitWagerTransactionalWriterImpl implements SubmitWagerTransactionalWriter {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async submit(walletId: string, decide: SubmitWagerDecide): Promise<SubmitWagerOutcome> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    // Tracks whether `commitTransaction()` already succeeded, so the `catch` below never
    // attempts a rollback after a commit — needed because the conflict path commits and then
    // throws `IdempotencyKeyConflictError` from inside this same `try` (spec: a conflict still
    // COMMITs, it just also surfaces as an error to the caller).
    let committed = false;

    try {
      const walletRow = await queryRunner.manager.findOne(WalletEntity, {
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!walletRow) {
        throw new WalletNotFoundError(walletId);
      }

      const lockedWallet = Wallet.rehydrate({
        id: walletRow.id,
        playerId: walletRow.playerId,
        currency: walletRow.currency,
        balance: Money.of(walletRow.balanceAmount, walletRow.currency),
        version: walletRow.version,
      });

      // Pure domain decision — no SQL happens inside `decide`. A thrown error here (e.g.
      // `CurrencyMismatchError`) propagates straight to the outer `catch`, aborting the whole
      // transaction: nothing gets persisted.
      const decision = decide(lockedWallet);

      await queryRunner.query(`SAVEPOINT ${SAVEPOINT_NAME}`);

      try {
        await queryRunner.manager.insert(WagerTransactionEntity, this.toWagerTransactionRow(decision.transaction));
      } catch (error) {
        if (!isIdempotencyKeyUniqueViolation(error)) {
          throw error;
        }

        await queryRunner.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT_NAME}`);
        const collision = await this.handleCollision(queryRunner, decision.transaction, lockedWallet.currency);

        // Design Notes: a conflict still COMMITs (nothing new was written — the speculative
        // insert was already undone by the savepoint rollback above) rather than rolling back
        // the whole transaction; `IdempotencyKeyConflictError` is thrown only after the commit
        // succeeds, so the wallet lock is released the ordinary way either way.
        await queryRunner.commitTransaction();
        committed = true;

        if (collision.kind === 'CONFLICT') {
          throw new IdempotencyKeyConflictError(collision.idempotencyKey);
        }

        return this.withFallbackBalance(collision.outcome, lockedWallet.balance);
      }

      const outcome = await this.applyDecision(queryRunner, decision);
      await queryRunner.commitTransaction();
      committed = true;
      return this.withFallbackBalance(outcome, lockedWallet.balance);
    } catch (error) {
      if (!committed) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // `LOSS` (and, on replay, anything `!affectsBalance()`) never gets a `balanceAfter` from
  // `applyDecision`/`handleCollision` — there is no ledger entry to freeze one from. The wallet
  // never moved for that kind, so the balance observed at lock time *is* the correct answer,
  // fresh or replayed alike.
  private withFallbackBalance(outcome: SubmitWagerOutcome, lockedWalletBalance: Money): SubmitWagerOutcome {
    if (outcome.transaction.status === 'PROCESSED' && outcome.balanceAfter === undefined) {
      return { ...outcome, balanceAfter: lockedWalletBalance };
    }
    return outcome;
  }

  private async applyDecision(queryRunner: QueryRunner, decision: SubmitWagerDecision): Promise<SubmitWagerOutcome> {
    const { transaction, wallet, ledgerEntry } = decision;

    if (transaction.status === 'REJECTED') {
      await this.insertOutbox(queryRunner, this.buildRejectedOutboxMessage(transaction));
      return { transaction, idempotentReplay: false };
    }

    if (transaction.status !== 'PROCESSED') {
      // Stories 2.1/2.2's `decide` callbacks only ever return PROCESSED/REJECTED —
      // PENDING_REFERENCE/FAILED aren't producible yet (Epic 2.3/3). Fail loudly rather than
      // silently treating an unexpected status as a REJECTED outcome once those become real.
      throw new Error(`Unexpected non-terminal status '${transaction.status}' from decide().`);
    }

    if (!wallet && !ledgerEntry) {
      // No balance effect (`LOSS`, README §7): only the transaction row + its
      // `WagerTransactionProcessed` event — no wallet update, no ledger entry, no
      // `WalletBalanceChanged` event.
      await this.insertOutbox(queryRunner, this.buildProcessedOutboxMessage(transaction));
      return { transaction, idempotentReplay: false };
    }

    if (!wallet || !ledgerEntry) {
      throw new Error('Invariant violation: a balance-affecting PROCESSED decision must carry both wallet and ledgerEntry.');
    }

    await queryRunner.manager.insert(WalletLedgerEntryEntity, {
      id: ledgerEntry.id,
      walletId: ledgerEntry.walletId,
      wagerTransactionId: ledgerEntry.wagerTransactionId,
      direction: ledgerEntry.direction,
      amount: ledgerEntry.money.amount,
      balanceBefore: ledgerEntry.balanceBefore.amount,
      balanceAfter: ledgerEntry.balanceAfter.amount,
    });

    await queryRunner.manager.update(
      WalletEntity,
      { id: wallet.id },
      { balanceAmount: wallet.balance.amount, version: wallet.version },
    );

    await this.insertOutbox(queryRunner, this.buildProcessedOutboxMessage(transaction));
    await this.insertOutbox(queryRunner, this.buildBalanceChangedOutboxMessage(wallet, ledgerEntry));

    return { transaction, balanceAfter: wallet.balance, idempotentReplay: false };
  }

  // Reads the row that won the `idempotency_key` race and decides replay vs. conflict. The
  // wallet lock acquired earlier in `submit` is still held — `ROLLBACK TO SAVEPOINT` only
  // undoes the speculative insert, not the surrounding transaction (spec "o lock da wallet
  // permanece"). Returns rather than throws for the conflict case — the caller commits before
  // deciding whether to surface `IdempotencyKeyConflictError` (spec "COMMIT (nada novo foi
  // escrito)").
  private async handleCollision(
    queryRunner: QueryRunner,
    attempted: WagerTransaction,
    walletCurrency: string,
  ): Promise<CollisionResult> {
    const existingRow = await queryRunner.manager.findOne(WagerTransactionEntity, {
      where: { idempotencyKey: attempted.idempotencyKey },
    });

    if (!existingRow) {
      // Unreachable in practice: a unique-violation on idempotency_key implies a row exists.
      throw new Error(`Idempotency key '${attempted.idempotencyKey}' collided but no row was found.`);
    }

    const existingTransaction = this.toDomainTransaction(existingRow, walletCurrency);

    if (!existingTransaction.matchesPayload(attempted.payloadHash)) {
      return { kind: 'CONFLICT', idempotencyKey: attempted.idempotencyKey };
    }

    if (existingTransaction.status === 'REJECTED') {
      return { kind: 'OUTCOME', outcome: { transaction: existingTransaction, idempotentReplay: true } };
    }

    if (existingTransaction.status !== 'PROCESSED') {
      // Stories 2.1/2.2 only ever produce PROCESSED/REJECTED — PENDING_REFERENCE/FAILED aren't
      // reachable yet (Epic 2.3/3). Fail loudly instead of silently misreporting an unexpected
      // status as a REJECTED-shaped replay once those become real.
      throw new Error(`Unexpected non-terminal status '${existingTransaction.status}' on idempotency replay.`);
    }

    if (!existingTransaction.affectsBalance()) {
      // `LOSS` — no ledger entry was ever written for it, so there's nothing to read a frozen
      // `balanceAfter` from. `submit`'s `withFallbackBalance` fills it in from the still-locked
      // wallet instead.
      return { kind: 'OUTCOME', outcome: { transaction: existingTransaction, idempotentReplay: true } };
    }

    const ledgerRow = await queryRunner.manager.findOne(WalletLedgerEntryEntity, {
      where: { wagerTransactionId: existingRow.id },
    });

    if (!ledgerRow) {
      throw new Error(`Expected a ledger entry for PROCESSED wager_transaction '${existingRow.id}'.`);
    }

    return {
      kind: 'OUTCOME',
      outcome: {
        transaction: existingTransaction,
        balanceAfter: Money.of(ledgerRow.balanceAfter, walletCurrency),
        idempotentReplay: true,
      },
    };
  }

  private toWagerTransactionRow(transaction: WagerTransaction) {
    return {
      id: transaction.id,
      walletId: transaction.walletId,
      kind: transaction.kind,
      status: transaction.status,
      amount: transaction.money.amount,
      idempotencyKey: transaction.idempotencyKey,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      payloadHash: transaction.payloadHash,
      failureCode: transaction.failureCode ?? null,
    };
  }

  private toDomainTransaction(row: WagerTransactionEntity, walletCurrency: string): WagerTransaction {
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
      money: Money.of(row.amount, walletCurrency),
      idempotencyKey: row.idempotencyKey ?? '',
      payloadHash: row.payloadHash ?? '',
      failureCode: row.failureCode ?? undefined,
      referenceTransactionId: row.referenceTransactionId ?? undefined,
    });
  }

  private async insertOutbox(
    queryRunner: QueryRunner,
    message: Record<string, unknown> & { type: string },
  ): Promise<void> {
    await queryRunner.manager.insert(OutboxMessageEntity, {
      id: randomUUID(),
      type: message.type,
      payload: message,
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });
  }

  private buildProcessedOutboxMessage(transaction: WagerTransaction) {
    return {
      type: 'WagerTransactionProcessed',
      transactionId: transaction.id,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      amount: transaction.money.amount,
      currency: transaction.money.currency,
      referenceTransactionId: transaction.referenceTransactionId,
      occurredAt: new Date().toISOString(),
    };
  }

  private buildRejectedOutboxMessage(transaction: WagerTransaction) {
    return {
      type: 'WagerTransactionRejected',
      transactionId: transaction.id,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
      amount: transaction.money.amount,
      currency: transaction.money.currency,
      referenceTransactionId: transaction.referenceTransactionId,
      occurredAt: new Date().toISOString(),
    };
  }

  private buildBalanceChangedOutboxMessage(wallet: Wallet, ledgerEntry: WalletLedgerEntry) {
    return {
      type: 'WalletBalanceChanged',
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      direction: ledgerEntry.direction,
      money: ledgerEntry.money.amount,
      balanceBefore: ledgerEntry.balanceBefore.amount,
      balanceAfter: ledgerEntry.balanceAfter.amount,
      wagerTransactionId: ledgerEntry.wagerTransactionId,
      walletVersion: wallet.version,
      occurredAt: new Date().toISOString(),
    };
  }
}
