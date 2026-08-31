// `wagering/infrastructure` — SubmitBetTransactionalWriterImpl (Story 2.1,
// ARCHITECTURE.md "Concorrência" / "Idempotência").
//
// Explicit `QueryRunner`, never `Repository.save()`. Lock order: wallet row `SELECT ... FOR
// UPDATE` first (blocking, no `NOWAIT`/`SKIP LOCKED`), then `decide()` runs pure domain logic
// with the locked wallet, then the speculative `wager_transactions` insert is guarded by a
// named `SAVEPOINT` issued as raw SQL (`queryRunner.query('SAVEPOINT ...')` /
// `'ROLLBACK TO SAVEPOINT ...'`) — deliberately never TypeORM's automatic nested-transaction
// savepoint (spec "Never" / ARCHITECTURE.md "Idempotência").
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
  SubmitBetDecide,
  SubmitBetDecision,
  SubmitBetOutcome,
  SubmitBetTransactionalWriter,
} from '../application/ports';

const IDEMPOTENCY_KEY_UNIQUE_CONSTRAINT = 'UQ_wager_transactions_idempotency_key';
const SAVEPOINT_NAME = 'submit_bet_speculative_insert';

// `handleCollision`'s result — `CONFLICT` carries just enough to build
// `IdempotencyKeyConflictError` after the caller commits (see `submit`).
type CollisionResult =
  | { kind: 'OUTCOME'; outcome: SubmitBetOutcome }
  | { kind: 'CONFLICT'; idempotencyKey: string };

function isIdempotencyKeyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }

  const driverError = error as unknown as { code?: string; constraint?: string };
  return driverError.code === '23505' && driverError.constraint === IDEMPOTENCY_KEY_UNIQUE_CONSTRAINT;
}

@Injectable()
export class SubmitBetTransactionalWriterImpl implements SubmitBetTransactionalWriter {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async submit(walletId: string, decide: SubmitBetDecide): Promise<SubmitBetOutcome> {
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

        return collision.outcome;
      }

      const outcome = await this.applyDecision(queryRunner, decision, lockedWallet);
      await queryRunner.commitTransaction();
      committed = true;
      return outcome;
    } catch (error) {
      if (!committed) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async applyDecision(
    queryRunner: QueryRunner,
    decision: SubmitBetDecision,
    lockedWallet: Wallet,
  ): Promise<SubmitBetOutcome> {
    const { transaction, wallet, ledgerEntry } = decision;

    if (transaction.status === 'REJECTED') {
      await this.insertOutbox(queryRunner, this.buildRejectedOutboxMessage(transaction));
      return { transaction, idempotentReplay: false };
    }

    if (transaction.status !== 'PROCESSED') {
      // Story 2.1's `decide` callbacks only ever return PROCESSED/REJECTED — PENDING_REFERENCE/
      // FAILED aren't producible yet (Epic 2.3/3). Fail loudly rather than silently treating an
      // unexpected status as a REJECTED outcome once those become real.
      throw new Error(`Unexpected non-terminal status '${transaction.status}' from decide().`);
    }

    if (!wallet || !ledgerEntry) {
      // Story 2.2 — LOSS decides PROCESSED without ever touching the wallet (spec "Never": no
      // WalletLedgerEntry, no WalletBalanceChanged) — `wallet`/`ledgerEntry` are both absent
      // together, never just one, and only for `kind === 'LOSS'`. Only `WagerTransactionProcessed`
      // is written; the response's balance is the wallet's untouched current balance
      // (`lockedWallet.balance`, read under the same lock) — there is no frozen ledger
      // `balanceAfter` to report because nothing changed.
      //
      // The `kind` check matters: without it, a future kind (or a bug) that forgets to set
      // `wallet`/`ledgerEntry` on a decision that *should* touch the balance would silently be
      // treated as a valid no-op instead of tripping the invariant error below.
      if (wallet || ledgerEntry || transaction.kind !== 'LOSS') {
        throw new Error('Invariant violation: a PROCESSED decision must carry both wallet and ledgerEntry, or neither (LOSS only).');
      }

      await this.insertOutbox(queryRunner, this.buildProcessedOutboxMessage(transaction));
      return { transaction, balanceAfter: lockedWallet.balance, idempotentReplay: false };
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
      // Story 2.1 only ever produces PROCESSED/REJECTED — PENDING_REFERENCE/FAILED aren't
      // reachable yet (Epic 2.3/3). Fail loudly instead of silently misreporting an unexpected
      // status as a REJECTED-shaped replay once those become real.
      throw new Error(`Unexpected non-terminal status '${existingTransaction.status}' on idempotency replay.`);
    }

    const ledgerRow = await queryRunner.manager.findOne(WalletLedgerEntryEntity, {
      where: { wagerTransactionId: existingRow.id },
    });

    if (!ledgerRow) {
      // Story 2.2 — a PROCESSED transaction with no ledger entry never touched the wallet
      // (`kind === 'LOSS'` only) — there is no frozen `balanceAfter` to replay. The wallet's
      // *current* balance is used instead, which is safe specifically because LOSS never changes
      // it (spec "saldo inalterado"): the wallet lock acquired at the top of `submit` is still
      // held, so this is a consistent read within the same transaction, not a race with a
      // concurrent writer.
      //
      // The `kind` check matters here too: a missing ledger row for any *other* PROCESSED kind is
      // a genuine data-integrity bug (Story 2.1's original invariant), not a legitimate no-op —
      // must still throw, never silently fall back to the current balance.
      if (existingTransaction.kind !== 'LOSS') {
        throw new Error(`Expected a ledger entry for PROCESSED wager_transaction '${existingRow.id}'.`);
      }

      const walletRow = await queryRunner.manager.findOne(WalletEntity, { where: { id: existingRow.walletId } });

      if (!walletRow) {
        // Unreachable in practice: every wager_transactions row is written in the same SQL
        // transaction as its wallet, and wallets are never deleted.
        throw new Error(`Invariant violation: no wallet found for wager_transaction '${existingRow.id}'.`);
      }

      return {
        kind: 'OUTCOME',
        outcome: {
          transaction: existingTransaction,
          balanceAfter: Money.of(walletRow.balanceAmount, walletCurrency),
          idempotentReplay: true,
        },
      };
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
      referenceTransactionId: transaction.referenceTransactionId ?? null,
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
      referenceTransactionId: transaction.referenceTransactionId ?? null,
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
