import { describe, expect, it, mock } from 'bun:test';
import type { Repository } from 'typeorm';
import type { WagerTransactionEntity } from '../../wallet/infrastructure/wager-transaction.entity';
import type { WalletEntity } from '../../wallet/infrastructure/wallet.entity';
import { WagerTransactionTypeOrmRepository } from './wager-transaction.typeorm-repository';

function buildWagerTransactionRow(overrides?: Partial<WagerTransactionEntity>): WagerTransactionEntity {
  return {
    id: 'tx-1',
    walletId: 'wallet-1',
    kind: 'BET',
    status: 'PROCESSED',
    amount: '25.00',
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
  } as WagerTransactionEntity;
}

function buildWalletRow(): WalletEntity {
  return {
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balanceAmount: '75.00',
    version: 2,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  } as WalletEntity;
}

function buildRepository(options?: {
  findTransaction?: (...args: unknown[]) => Promise<WagerTransactionEntity | null>;
  findWallet?: (...args: unknown[]) => Promise<WalletEntity | null>;
}) {
  const findOneByTransaction = mock(options?.findTransaction ?? (() => Promise.resolve(null)));
  const findOneByWallet = mock(options?.findWallet ?? (() => Promise.resolve(buildWalletRow())));

  const transactionRepository = { findOneBy: findOneByTransaction } as unknown as Repository<WagerTransactionEntity>;
  const walletRepository = { findOneBy: findOneByWallet } as unknown as Repository<WalletEntity>;

  const adapter = new WagerTransactionTypeOrmRepository(transactionRepository, walletRepository);
  return { adapter, findOneByTransaction, findOneByWallet };
}

describe('WagerTransactionTypeOrmRepository', () => {
  describe('findById', () => {
    it('maps the row (and its wallet currency) into a rehydrated WagerTransaction', async () => {
      const { adapter, findOneByTransaction } = buildRepository({
        findTransaction: () => Promise.resolve(buildWagerTransactionRow()),
      });

      const transaction = await adapter.findById('tx-1');

      expect(findOneByTransaction).toHaveBeenCalledWith({ id: 'tx-1' });
      expect(transaction).not.toBeNull();
      expect(transaction?.id).toBe('tx-1');
      expect(transaction?.status).toBe('PROCESSED');
      expect(transaction?.kind).toBe('BET');
      expect(transaction?.money.amount).toBe('25.00');
      expect(transaction?.money.currency).toBe('BRL');
      expect(transaction?.providerId).toBe('provider-a');
      expect(transaction?.externalTransactionId).toBe('transaction-123');
    });

    it('returns null when no row matches', async () => {
      const { adapter } = buildRepository();

      const transaction = await adapter.findById('missing-id');

      expect(transaction).toBeNull();
    });
  });

  describe('findByProviderAndExternalId', () => {
    it('queries by the (providerId, externalTransactionId) pair', async () => {
      const { adapter, findOneByTransaction } = buildRepository({
        findTransaction: () => Promise.resolve(buildWagerTransactionRow()),
      });

      const transaction = await adapter.findByProviderAndExternalId('provider-a', 'transaction-123');

      expect(findOneByTransaction).toHaveBeenCalledWith({
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
      });
      expect(transaction?.id).toBe('tx-1');
    });

    it('returns null when no row matches', async () => {
      const { adapter } = buildRepository();

      const transaction = await adapter.findByProviderAndExternalId('provider-a', 'never-submitted');

      expect(transaction).toBeNull();
    });
  });

  describe('rejected transaction mapping', () => {
    it('carries failureCode through', async () => {
      const { adapter } = buildRepository({
        findTransaction: () =>
          Promise.resolve(buildWagerTransactionRow({ status: 'REJECTED', failureCode: 'INSUFFICIENT_BALANCE' })),
      });

      const transaction = await adapter.findById('tx-1');

      expect(transaction?.status).toBe('REJECTED');
      expect(transaction?.failureCode).toBe('INSUFFICIENT_BALANCE');
    });
  });
});
