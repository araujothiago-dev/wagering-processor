import { describe, expect, it, mock } from 'bun:test';
import type { Repository } from 'typeorm';
import { LedgerCursorError, encodeLedgerCursor } from './ledger-cursor.codec';
import { WalletLedgerTypeOrmRepository } from './wallet-ledger.typeorm-repository';
import type { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';

function buildRow(overrides: Partial<WalletLedgerEntryEntity> = {}): WalletLedgerEntryEntity {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    wagerTransactionId: 'tx-1',
    direction: 'CREDIT',
    amount: '10.00',
    balanceBefore: '0.00',
    balanceAfter: '10.00',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildQueryBuilder(rows: WalletLedgerEntryEntity[]) {
  const calls: { where: unknown[]; andWhere: unknown[]; orderBy: unknown[]; addOrderBy: unknown[]; take: unknown[] } = {
    where: [],
    andWhere: [],
    orderBy: [],
    addOrderBy: [],
    take: [],
  };

  const queryBuilder = {
    where: mock((...args: unknown[]) => {
      calls.where.push(args);
      return queryBuilder;
    }),
    andWhere: mock((...args: unknown[]) => {
      calls.andWhere.push(args);
      return queryBuilder;
    }),
    orderBy: mock((...args: unknown[]) => {
      calls.orderBy.push(args);
      return queryBuilder;
    }),
    addOrderBy: mock((...args: unknown[]) => {
      calls.addOrderBy.push(args);
      return queryBuilder;
    }),
    take: mock((...args: unknown[]) => {
      calls.take.push(args);
      return queryBuilder;
    }),
    getMany: mock(() => Promise.resolve(rows)),
  };

  return { queryBuilder, calls };
}

function buildRepository(rows: WalletLedgerEntryEntity[]) {
  const { queryBuilder, calls } = buildQueryBuilder(rows);
  const createQueryBuilder = mock(() => queryBuilder);
  const repository = { createQueryBuilder } as unknown as Repository<WalletLedgerEntryEntity>;
  return { repository, createQueryBuilder, queryBuilder, calls };
}

describe('WalletLedgerTypeOrmRepository', () => {
  describe('WHERE clause — without cursor', () => {
    it('filters by walletId only, ordered createdAt ASC then id ASC, fetching limit + 1', async () => {
      const { repository, calls } = buildRepository([buildRow()]);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      await adapter.list({ walletId: 'wallet-1', currency: 'USD', limit: 50 });

      expect(calls.where).toEqual([['entry.walletId = :walletId', { walletId: 'wallet-1' }]]);
      expect(calls.andWhere).toHaveLength(0);
      expect(calls.orderBy).toEqual([['entry.createdAt', 'ASC']]);
      expect(calls.addOrderBy).toEqual([['entry.id', 'ASC']]);
      expect(calls.take).toEqual([[51]]);
    });
  });

  describe('WHERE clause — with cursor', () => {
    it('adds the keyset tuple comparison decoded from the cursor, with explicit type casts', async () => {
      const cursor = encodeLedgerCursor({
        walletId: 'wallet-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'entry-0',
      });
      const { repository, calls } = buildRepository([]);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      await adapter.list({ walletId: 'wallet-1', currency: 'USD', limit: 50, cursor });

      expect(calls.andWhere).toEqual([
        [
          '(entry.createdAt, entry.id) > ((:cursorCreatedAt)::timestamptz, (:cursorId)::uuid)',
          { cursorCreatedAt: '2026-01-01T00:00:00.000Z', cursorId: 'entry-0' },
        ],
      ]);
    });

    it('propagates LedgerCursorError for an undecodable cursor without querying', async () => {
      const { repository, createQueryBuilder } = buildRepository([]);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      const error = await adapter
        .list({ walletId: 'wallet-1', currency: 'USD', limit: 50, cursor: 'lixo-nao-decodificavel' })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(LedgerCursorError);
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rejects a cursor issued for a different wallet without querying', async () => {
      const cursor = encodeLedgerCursor({
        walletId: 'some-other-wallet',
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'entry-0',
      });
      const { repository, createQueryBuilder } = buildRepository([]);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      const error = await adapter
        .list({ walletId: 'wallet-1', currency: 'USD', limit: 50, cursor })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(LedgerCursorError);
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('nextCursor', () => {
    it('is present and points at the last entry when there are more than limit rows', async () => {
      const rows = [
        buildRow({ id: 'entry-1', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        buildRow({ id: 'entry-2', createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      ];
      const { repository } = buildRepository(rows);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      const result = await adapter.list({ walletId: 'wallet-1', currency: 'USD', limit: 1 });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.id).toBe('entry-1');
      expect(result.nextCursor).toBeDefined();
      expect(result.nextCursor).toBe(
        encodeLedgerCursor({ walletId: 'wallet-1', createdAt: '2026-01-01T00:00:00.000Z', id: 'entry-1' }),
      );
    });

    it('breaks a tie on identical createdAt values using the id of the actual last page entry', async () => {
      // Rows 1 and 2 share the exact same millisecond; only `id` (already ordered ASC by the
      // real query) distinguishes which one ends a page of size 2 from row 3, which shares that
      // same timestamp too.
      const tiedCreatedAt = new Date('2026-01-01T00:00:00.000Z');
      const rows = [
        buildRow({ id: 'entry-1', createdAt: tiedCreatedAt }),
        buildRow({ id: 'entry-2', createdAt: tiedCreatedAt }),
        buildRow({ id: 'entry-3', createdAt: tiedCreatedAt }),
      ];
      const { repository: firstPageRepository } = buildRepository(rows);
      const adapter = new WalletLedgerTypeOrmRepository(firstPageRepository);

      const firstPage = await adapter.list({ walletId: 'wallet-1', currency: 'USD', limit: 2 });

      expect(firstPage.entries.map((entry) => entry.id)).toEqual(['entry-1', 'entry-2']);
      const expectedCursor = encodeLedgerCursor({
        walletId: 'wallet-1',
        createdAt: tiedCreatedAt.toISOString(),
        id: 'entry-2',
      });
      expect(firstPage.nextCursor).toBe(expectedCursor);

      // Following that cursor must filter on `entry-2`'s id, not just the shared timestamp —
      // otherwise `entry-3` (same createdAt) would be skipped or `entry-2` repeated.
      const { repository: secondPageRepository, calls } = buildRepository([rows[2]!]);
      const secondPageAdapter = new WalletLedgerTypeOrmRepository(secondPageRepository);

      const secondPage = await secondPageAdapter.list({
        walletId: 'wallet-1',
        currency: 'USD',
        limit: 2,
        cursor: firstPage.nextCursor,
      });

      expect(calls.andWhere).toEqual([
        [
          '(entry.createdAt, entry.id) > ((:cursorCreatedAt)::timestamptz, (:cursorId)::uuid)',
          { cursorCreatedAt: tiedCreatedAt.toISOString(), cursorId: 'entry-2' },
        ],
      ]);
      expect(secondPage.entries.map((entry) => entry.id)).toEqual(['entry-3']);
      expect(secondPage.nextCursor).toBeUndefined();
    });

    it('is undefined when there are exactly limit rows or fewer', async () => {
      const rows = [buildRow({ id: 'entry-1' })];
      const { repository } = buildRepository(rows);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      const result = await adapter.list({ walletId: 'wallet-1', currency: 'USD', limit: 1 });

      expect(result.entries).toHaveLength(1);
      expect(result.nextCursor).toBeUndefined();
    });

    it('is undefined for an empty page', async () => {
      const { repository } = buildRepository([]);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      const result = await adapter.list({ walletId: 'wallet-1', currency: 'USD', limit: 50 });

      expect(result.entries).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
    });
  });

  describe('mapping', () => {
    it('reconstructs each row as a WalletLedgerEntry using the given currency', async () => {
      const row = buildRow({ direction: 'CREDIT', amount: '25.50', balanceBefore: '0.00', balanceAfter: '25.50' });
      const { repository } = buildRepository([row]);
      const adapter = new WalletLedgerTypeOrmRepository(repository);

      const result = await adapter.list({ walletId: 'wallet-1', currency: 'EUR', limit: 50 });

      const entry = result.entries[0];
      expect(entry?.id).toBe('entry-1');
      expect(entry?.walletId).toBe('wallet-1');
      expect(entry?.wagerTransactionId).toBe('tx-1');
      expect(entry?.direction).toBe('CREDIT');
      expect(entry?.money.amount).toBe('25.50');
      expect(entry?.money.currency).toBe('EUR');
      expect(entry?.balanceBefore.amount).toBe('0.00');
      expect(entry?.balanceAfter.amount).toBe('25.50');
      expect(entry?.createdAt).toEqual(row.createdAt);
    });
  });
});
