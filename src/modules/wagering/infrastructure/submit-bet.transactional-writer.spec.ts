import { describe, expect, it, mock } from 'bun:test';
import { QueryFailedError, type DataSource } from 'typeorm';
import { Money } from '../../../shared/money';
import { WalletNotFoundError } from '../../wallet/domain/errors';
import { Wallet } from '../../wallet/domain/wallet';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { OutboxMessageEntity } from '../../wallet/infrastructure/outbox-message.entity';
import { WagerTransactionEntity } from '../../wallet/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../wallet/infrastructure/wallet-ledger-entry.entity';
import { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { IdempotencyKeyConflictError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import type { SubmitBetDecide, SubmitBetDecision } from '../application/ports';
import { SubmitBetTransactionalWriterImpl } from './submit-bet.transactional-writer';

const WALLET_ID = 'wallet-1';
const SAVEPOINT_SQL = 'SAVEPOINT submit_bet_speculative_insert';
const ROLLBACK_TO_SAVEPOINT_SQL = 'ROLLBACK TO SAVEPOINT submit_bet_speculative_insert';

function buildWalletRow() {
  return { id: WALLET_ID, playerId: 'player-1', currency: 'BRL', balanceAmount: '100.00', version: 1 };
}

function buildQueryRunner(options?: {
  findOne?: (entity: unknown, opts: unknown) => Promise<unknown>;
  insert?: (entity: unknown, row: unknown) => Promise<unknown>;
}) {
  return {
    query: mock((..._args: unknown[]) => Promise.resolve(undefined)),
    connect: mock(() => Promise.resolve()),
    startTransaction: mock(() => Promise.resolve()),
    commitTransaction: mock(() => Promise.resolve()),
    rollbackTransaction: mock(() => Promise.resolve()),
    release: mock(() => Promise.resolve()),
    manager: {
      findOne: mock(options?.findOne ?? (() => Promise.resolve(null))),
      insert: mock(options?.insert ?? (() => Promise.resolve(undefined))),
      update: mock(() => Promise.resolve(undefined)),
    },
  };
}

function buildDataSource(queryRunner: ReturnType<typeof buildQueryRunner>): DataSource {
  return { createQueryRunner: mock(() => queryRunner) } as unknown as DataSource;
}

function buildUniqueViolation(): QueryFailedError {
  return new QueryFailedError('INSERT INTO wager_transactions ...', [], {
    name: 'error',
    code: '23505',
    constraint: 'UQ_wager_transactions_idempotency_key',
    message: 'duplicate key value violates unique constraint',
  } as unknown as Error);
}

function buildProcessedDecision(transactionId: string, payloadHash = 'hash-1'): SubmitBetDecision {
  const wallet = Wallet.rehydrate({
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance: Money.of('70.00', 'BRL'),
    version: 2,
  });
  const ledgerEntry = WalletLedgerEntry.debit({
    walletId: WALLET_ID,
    wagerTransactionId: transactionId,
    money: Money.of('30.00', 'BRL'),
    balanceBefore: Money.of('100.00', 'BRL'),
    balanceAfter: Money.of('70.00', 'BRL'),
  });
  const transaction = WagerTransaction.processed({
    id: transactionId,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.of('30.00', 'BRL'),
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash,
  });

  return { transaction, wallet, ledgerEntry };
}

// Story 2.2 — a WIN that resolved its optional reference to a BET: `referenceTransactionId` must
// survive all the way to the persisted `WagerTransactionEntity` row and the outbox payload, not
// just the in-memory `decision.transaction` object.
function buildWinDecisionWithReference(transactionId: string, referenceTransactionId: string, payloadHash = 'hash-win'): SubmitBetDecision {
  const wallet = Wallet.rehydrate({
    id: WALLET_ID,
    playerId: 'player-1',
    currency: 'BRL',
    balance: Money.of('130.00', 'BRL'),
    version: 2,
  });
  const ledgerEntry = WalletLedgerEntry.credit({
    walletId: WALLET_ID,
    wagerTransactionId: transactionId,
    money: Money.of('30.00', 'BRL'),
    balanceBefore: Money.of('100.00', 'BRL'),
    balanceAfter: Money.of('130.00', 'BRL'),
  });
  const transaction = WagerTransaction.processed({
    id: transactionId,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-win-123',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'WIN',
    money: Money.of('30.00', 'BRL'),
    idempotencyKey: 'provider-a:transaction-win-123',
    payloadHash,
    referenceTransactionId,
  });

  return { transaction, wallet, ledgerEntry };
}

// Story 2.2 — LOSS decides PROCESSED without ever touching the wallet: no `wallet`/`ledgerEntry`
// on the decision (spec "Never": no WalletLedgerEntry, no WalletBalanceChanged).
function buildWalletUntouchedProcessedDecision(transactionId: string, payloadHash = 'hash-loss'): SubmitBetDecision {
  const transaction = WagerTransaction.processed({
    id: transactionId,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-loss-123',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'LOSS',
    money: Money.of('40.00', 'BRL'),
    idempotencyKey: 'provider-a:transaction-loss-123',
    payloadHash,
  });

  return { transaction };
}

function buildRejectedDecision(transactionId: string, payloadHash = 'hash-1'): SubmitBetDecision {
  const transaction = WagerTransaction.rejected({
    id: transactionId,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: WALLET_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.of('300.00', 'BRL'),
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash,
    failureCode: 'INSUFFICIENT_BALANCE',
  });

  return { transaction };
}

function buildExistingWagerRow(overrides?: Record<string, unknown>) {
  return {
    id: 'tx-original',
    walletId: WALLET_ID,
    kind: 'BET',
    status: 'PROCESSED',
    amount: '30.00',
    idempotencyKey: 'provider-a:transaction-123',
    referenceTransactionId: null,
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    payloadHash: 'hash-1',
    failureCode: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const EXISTING_LEDGER_ROW = {
  id: 'ledger-1',
  walletId: WALLET_ID,
  wagerTransactionId: 'tx-original',
  direction: 'DEBIT',
  amount: '30.00',
  balanceBefore: '100.00',
  balanceAfter: '70.00',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('SubmitBetTransactionalWriterImpl', () => {
  describe('success — fresh PROCESSED insert', () => {
    it('locks the wallet, inserts ledger + 2 outbox rows, updates the wallet, and commits', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => (entity === WalletEntity ? Promise.resolve(buildWalletRow()) : Promise.resolve(null)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = mock((wallet) => {
        expect(wallet.balance.amount).toBe('100.00');
        return buildProcessedDecision('tx-1');
      });

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.status).toBe('PROCESSED');
      expect(outcome.balanceAfter?.amount).toBe('70.00');
      expect(outcome.idempotentReplay).toBe(false);

      expect(decide).toHaveBeenCalledTimes(1);
      expect(queryRunner.manager.findOne).toHaveBeenCalledWith(WalletEntity, {
        where: { id: WALLET_ID },
        lock: { mode: 'pessimistic_write' },
      });

      expect(queryRunner.manager.insert).toHaveBeenCalledTimes(4);
      const insertedEntities = queryRunner.manager.insert.mock.calls.map((call) => call[0]);
      expect(insertedEntities).toEqual([WagerTransactionEntity, WalletLedgerEntryEntity, OutboxMessageEntity, OutboxMessageEntity]);

      const wagerTransactionRow = queryRunner.manager.insert.mock.calls[0]?.[1];
      expect(wagerTransactionRow).toEqual({
        id: 'tx-1',
        walletId: WALLET_ID,
        kind: 'BET',
        status: 'PROCESSED',
        amount: '30.00',
        idempotencyKey: 'provider-a:transaction-123',
        referenceTransactionId: null,
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: 'player-1',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        payloadHash: 'hash-1',
        failureCode: null,
      });

      expect(queryRunner.manager.update).toHaveBeenCalledTimes(1);
      expect(queryRunner.query).toHaveBeenCalledTimes(1);
      expect(queryRunner.query).toHaveBeenCalledWith(SAVEPOINT_SQL);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalledTimes(1);
    });
  });

  describe('success — fresh PROCESSED insert, WIN with a resolved reference', () => {
    it('persists referenceTransactionId on the wager_transaction row and on the WagerTransactionProcessed outbox payload', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => (entity === WalletEntity ? Promise.resolve(buildWalletRow()) : Promise.resolve(null)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = () => buildWinDecisionWithReference('tx-win-1', 'tx-bet-original');

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.status).toBe('PROCESSED');
      expect(outcome.transaction.referenceTransactionId).toBe('tx-bet-original');

      const wagerTransactionRow = queryRunner.manager.insert.mock.calls[0]?.[1] as { referenceTransactionId: unknown };
      expect(wagerTransactionRow.referenceTransactionId).toBe('tx-bet-original');

      const outboxRows = queryRunner.manager.insert.mock.calls
        .filter((call) => call[0] === OutboxMessageEntity)
        .map((call) => call[1] as { payload: { type: string; referenceTransactionId?: unknown } });
      const processedOutboxRow = outboxRows.find((row) => row.payload.type === 'WagerTransactionProcessed');
      expect(processedOutboxRow?.payload.referenceTransactionId).toBe('tx-bet-original');
    });
  });

  describe('success — fresh PROCESSED insert, wallet untouched (LOSS)', () => {
    it('inserts only the wager_transaction row + 1 outbox row, no ledger/wallet update, returns the locked balance', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => (entity === WalletEntity ? Promise.resolve(buildWalletRow()) : Promise.resolve(null)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = mock((wallet) => {
        expect(wallet.balance.amount).toBe('100.00');
        return buildWalletUntouchedProcessedDecision('tx-loss-1');
      });

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.status).toBe('PROCESSED');
      // Untouched balance — the wallet's balance as locked, never mutated.
      expect(outcome.balanceAfter?.amount).toBe('100.00');
      expect(outcome.idempotentReplay).toBe(false);

      expect(queryRunner.manager.insert).toHaveBeenCalledTimes(2);
      const insertedEntities = queryRunner.manager.insert.mock.calls.map((call) => call[0]);
      expect(insertedEntities).toEqual([WagerTransactionEntity, OutboxMessageEntity]);
      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });
  });

  describe('rejection — fresh REJECTED insert (insufficient balance)', () => {
    it('inserts only the wager_transaction row + 1 outbox row, no ledger/wallet update, and commits', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => (entity === WalletEntity ? Promise.resolve(buildWalletRow()) : Promise.resolve(null)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = () => buildRejectedDecision('tx-2');

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.status).toBe('REJECTED');
      expect(outcome.balanceAfter).toBeUndefined();
      expect(outcome.idempotentReplay).toBe(false);

      expect(queryRunner.manager.insert).toHaveBeenCalledTimes(2);
      const insertedEntities = queryRunner.manager.insert.mock.calls.map((call) => call[0]);
      expect(insertedEntities).toEqual([WagerTransactionEntity, OutboxMessageEntity]);
      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });
  });

  describe('wallet not found', () => {
    it('throws WalletNotFoundError without invoking decide, and rolls back', async () => {
      const queryRunner = buildQueryRunner({ findOne: () => Promise.resolve(null) });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide = mock((): SubmitBetDecision => {
        throw new Error('decide must not be called when the wallet does not exist');
      });

      await expect(writer.submit(WALLET_ID, decide)).rejects.toBeInstanceOf(WalletNotFoundError);

      expect(decide).not.toHaveBeenCalled();
      expect(queryRunner.query).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('decide throws (e.g. currency mismatch)', () => {
    it('aborts the whole transaction — no speculative insert is ever attempted', async () => {
      class FakeCurrencyMismatchError extends Error {}
      const queryRunner = buildQueryRunner({
        findOne: (entity) => (entity === WalletEntity ? Promise.resolve(buildWalletRow()) : Promise.resolve(null)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = () => {
        throw new FakeCurrencyMismatchError('currency mismatch');
      };

      await expect(writer.submit(WALLET_ID, decide)).rejects.toBeInstanceOf(FakeCurrencyMismatchError);

      expect(queryRunner.query).not.toHaveBeenCalled();
      expect(queryRunner.manager.insert).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });
  });

  describe('replay — PROCESSED', () => {
    it('rolls back to the savepoint, reads the existing row + ledger entry, and commits', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => {
          if (entity === WalletEntity) return Promise.resolve(buildWalletRow());
          if (entity === WagerTransactionEntity) return Promise.resolve(buildExistingWagerRow());
          if (entity === WalletLedgerEntryEntity) return Promise.resolve(EXISTING_LEDGER_ROW);
          return Promise.resolve(null);
        },
        insert: (entity) => (entity === WagerTransactionEntity ? Promise.reject(buildUniqueViolation()) : Promise.resolve(undefined)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = () => buildProcessedDecision('tx-attempt');

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.id).toBe('tx-original');
      expect(outcome.transaction.status).toBe('PROCESSED');
      expect(outcome.balanceAfter?.amount).toBe('70.00');
      expect(outcome.idempotentReplay).toBe(true);

      // Only the failed speculative insert was attempted — no ledger/outbox writes for a replay.
      expect(queryRunner.manager.insert).toHaveBeenCalledTimes(1);
      // The single most important invariant of a replay: never re-debit the wallet.
      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(queryRunner.query).toHaveBeenCalledWith(SAVEPOINT_SQL);
      expect(queryRunner.query).toHaveBeenCalledWith(ROLLBACK_TO_SAVEPOINT_SQL);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });
  });

  describe('replay — PROCESSED, wallet untouched (LOSS)', () => {
    it('finds no ledger row, falls back to the wallet current balance, and commits', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => {
          if (entity === WalletEntity) return Promise.resolve(buildWalletRow());
          if (entity === WagerTransactionEntity) {
            return Promise.resolve(
              buildExistingWagerRow({
                id: 'tx-loss-original',
                kind: 'LOSS',
                externalTransactionId: 'transaction-loss-123',
                idempotencyKey: 'provider-a:transaction-loss-123',
                amount: '40.00',
                payloadHash: 'hash-loss',
              }),
            );
          }
          // No WalletLedgerEntryEntity row — LOSS never writes one.
          return Promise.resolve(null);
        },
        insert: (entity) => (entity === WagerTransactionEntity ? Promise.reject(buildUniqueViolation()) : Promise.resolve(undefined)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = () => buildWalletUntouchedProcessedDecision('tx-loss-attempt');

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.id).toBe('tx-loss-original');
      expect(outcome.transaction.status).toBe('PROCESSED');
      // Falls back to the wallet's current balance — safe because LOSS never changes it.
      expect(outcome.balanceAfter?.amount).toBe('100.00');
      expect(outcome.idempotentReplay).toBe(true);

      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });
  });

  describe('replay — REJECTED', () => {
    it('never looks up a ledger entry and returns no balanceAfter', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => {
          if (entity === WalletEntity) return Promise.resolve(buildWalletRow());
          if (entity === WagerTransactionEntity) {
            return Promise.resolve(buildExistingWagerRow({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' }));
          }
          return Promise.resolve(null);
        },
        insert: (entity) => (entity === WagerTransactionEntity ? Promise.reject(buildUniqueViolation()) : Promise.resolve(undefined)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      const decide: SubmitBetDecide = () => buildRejectedDecision('tx-attempt');

      const outcome = await writer.submit(WALLET_ID, decide);

      expect(outcome.transaction.status).toBe('REJECTED');
      expect(outcome.balanceAfter).toBeUndefined();
      expect(outcome.idempotentReplay).toBe(true);

      const findOneEntities = queryRunner.manager.findOne.mock.calls.map((call) => call[0]);
      expect(findOneEntities).not.toContain(WalletLedgerEntryEntity);
      expect(queryRunner.manager.update).not.toHaveBeenCalled();
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency-key conflict', () => {
    it('commits (nothing new was written) and still throws IdempotencyKeyConflictError', async () => {
      const queryRunner = buildQueryRunner({
        findOne: (entity) => {
          if (entity === WalletEntity) return Promise.resolve(buildWalletRow());
          if (entity === WagerTransactionEntity) return Promise.resolve(buildExistingWagerRow({ payloadHash: 'hash-1' }));
          return Promise.resolve(null);
        },
        insert: (entity) => (entity === WagerTransactionEntity ? Promise.reject(buildUniqueViolation()) : Promise.resolve(undefined)),
      });
      const writer = new SubmitBetTransactionalWriterImpl(buildDataSource(queryRunner));
      // Different payloadHash than the existing row ('hash-1') => conflict, not replay.
      const decide: SubmitBetDecide = () => buildProcessedDecision('tx-attempt', 'hash-DIFFERENT');

      await expect(writer.submit(WALLET_ID, decide)).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

      expect(queryRunner.query).toHaveBeenCalledWith(SAVEPOINT_SQL);
      expect(queryRunner.query).toHaveBeenCalledWith(ROLLBACK_TO_SAVEPOINT_SQL);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });
  });
});
