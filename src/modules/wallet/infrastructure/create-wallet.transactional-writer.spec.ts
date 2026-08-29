import { describe, expect, it, mock } from 'bun:test';
import { QueryFailedError, type DataSource } from 'typeorm';
import { Money } from '../../../shared/money';
import { WalletAlreadyExistsError } from '../domain/errors';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { Wallet } from '../domain/wallet';
import type { CreateWalletOpeningWrite } from '../application/ports';
import { CreateWalletTransactionalWriterImpl } from './create-wallet.transactional-writer';
import { WALLET_PLAYER_CURRENCY_UNIQUE_CONSTRAINT } from './wallet.entity';

function buildQueryRunner(insertImpl?: (...args: unknown[]) => Promise<unknown>) {
  return {
    connect: mock(() => Promise.resolve()),
    startTransaction: mock(() => Promise.resolve()),
    commitTransaction: mock(() => Promise.resolve()),
    rollbackTransaction: mock(() => Promise.resolve()),
    release: mock(() => Promise.resolve()),
    manager: { insert: mock(insertImpl ?? ((..._args: unknown[]) => Promise.resolve())) },
  };
}

function buildDataSource(queryRunner: ReturnType<typeof buildQueryRunner>): DataSource {
  return { createQueryRunner: mock(() => queryRunner) } as unknown as DataSource;
}

function buildOpening(wallet: Wallet): CreateWalletOpeningWrite {
  const wagerTransactionId = 'tx-1';
  const ledgerEntry = WalletLedgerEntry.credit({
    walletId: wallet.id,
    wagerTransactionId,
    money: wallet.balance,
    balanceBefore: Money.zero(wallet.currency),
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
      balanceBefore: '0.00',
      balanceAfter: wallet.balance.amount,
      wagerTransactionId,
      occurredAt: new Date().toISOString(),
    },
  };
}

describe('CreateWalletTransactionalWriterImpl', () => {
  it('inserts only the wallet row when there is no opening bundle', async () => {
    const queryRunner = buildQueryRunner();
    const writer = new CreateWalletTransactionalWriterImpl(buildDataSource(queryRunner));
    const wallet = Wallet.open('player-1', 'USD');

    await writer.write({ wallet });

    expect(queryRunner.manager.insert).toHaveBeenCalledTimes(1);
    const [entity, row] = queryRunner.manager.insert.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(row).toEqual({
      id: wallet.id,
      playerId: 'player-1',
      currency: 'USD',
      balanceAmount: '0.00',
      version: 1,
    });
    expect(entity).toBeDefined();
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('inserts wallet, wager_transaction, ledger entry, and outbox rows for an opening bundle', async () => {
    const queryRunner = buildQueryRunner();
    const writer = new CreateWalletTransactionalWriterImpl(buildDataSource(queryRunner));
    const wallet = Wallet.open('player-1', 'USD', '50.00');
    const opening = buildOpening(wallet);

    await writer.write({ wallet, opening });

    expect(queryRunner.manager.insert).toHaveBeenCalledTimes(4);

    const [, wagerRow] = queryRunner.manager.insert.mock.calls[1] as [unknown, Record<string, unknown>];
    expect(wagerRow).toEqual({
      id: 'tx-1',
      walletId: wallet.id,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '50.00',
      idempotencyKey: null,
      referenceTransactionId: null,
    });

    const [, ledgerRow] = queryRunner.manager.insert.mock.calls[2] as [unknown, Record<string, unknown>];
    expect(ledgerRow).toEqual({
      id: opening.ledgerEntry.id,
      walletId: wallet.id,
      wagerTransactionId: 'tx-1',
      direction: 'CREDIT',
      amount: '50.00',
      balanceBefore: '0.00',
      balanceAfter: '50.00',
    });

    const [, outboxRow] = queryRunner.manager.insert.mock.calls[3] as [unknown, Record<string, unknown>];
    expect(outboxRow).toMatchObject({
      type: 'WalletBalanceChanged',
      payload: opening.outboxMessage,
      attempts: 0,
      nextAttemptAt: null,
      publishedAt: null,
    });

    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('translates the wallet unique-violation into WalletAlreadyExistsError and rolls back', async () => {
    const violation = new QueryFailedError('INSERT INTO wallets ...', [], {
      name: 'error',
      code: '23505',
      constraint: WALLET_PLAYER_CURRENCY_UNIQUE_CONSTRAINT,
      message: 'duplicate key value violates unique constraint',
    } as unknown as Error);

    const queryRunner = buildQueryRunner(() => Promise.reject(violation));
    const writer = new CreateWalletTransactionalWriterImpl(buildDataSource(queryRunner));
    const wallet = Wallet.open('player-1', 'USD');

    await expect(writer.write({ wallet })).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('propagates any other error untranslated and still rolls back', async () => {
    const otherError = new Error('connection lost');
    const queryRunner = buildQueryRunner(() => Promise.reject(otherError));
    const writer = new CreateWalletTransactionalWriterImpl(buildDataSource(queryRunner));
    const wallet = Wallet.open('player-1', 'USD');

    await expect(writer.write({ wallet })).rejects.toBe(otherError);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('does not translate a unique violation from a different constraint', async () => {
    const violation = new QueryFailedError('INSERT INTO wager_transactions ...', [], {
      name: 'error',
      code: '23505',
      constraint: 'UQ_wager_transactions_idempotency_key',
      message: 'duplicate key value violates unique constraint',
    } as unknown as Error);

    const queryRunner = buildQueryRunner(() => Promise.reject(violation));
    const writer = new CreateWalletTransactionalWriterImpl(buildDataSource(queryRunner));
    const wallet = Wallet.open('player-1', 'USD');

    await expect(writer.write({ wallet })).rejects.toBe(violation);
  });
});
