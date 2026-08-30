import { describe, expect, it, mock } from 'bun:test';
import { Money } from '../../../shared/money';
import { WalletNotFoundError } from '../domain/errors';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { GetWalletLedgerLimitError, GetWalletLedgerUseCase } from './get-wallet-ledger.use-case';
import type { ListWalletLedgerParams, ListWalletLedgerResult, WalletLedgerRepository, WalletRepository } from './ports';

function buildWallet(): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'USD',
    balance: Money.of('50.00', 'USD'),
    version: 2,
  });
}

function buildWalletRepository(impl?: (id: string) => Promise<Wallet | null>) {
  const findById = mock(impl ?? (() => Promise.resolve(buildWallet())));
  const repository: WalletRepository = { findById };
  return { repository, findById };
}

function buildLedgerRepository(impl?: (params: ListWalletLedgerParams) => Promise<ListWalletLedgerResult>) {
  const list = mock(impl ?? (() => Promise.resolve({ entries: [] })));
  const listAll = mock(() => Promise.resolve([]));
  const repository: WalletLedgerRepository = { list, listAll };
  return { repository, list, listAll };
}

class FakeCursorError extends Error {
  readonly code = 'VALIDATION_INVALID_CURSOR' as const;
}

describe('GetWalletLedgerUseCase', () => {
  describe('happy path — without cursor', () => {
    it('checks wallet existence then delegates pagination to the port, passing the wallet currency', async () => {
      const entry = WalletLedgerEntry.rehydrate({
        id: 'entry-1',
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        direction: 'CREDIT',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('50.00', 'USD'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const { repository: walletRepository, findById } = buildWalletRepository();
      const { repository: ledgerRepository, list } = buildLedgerRepository(() =>
        Promise.resolve({ entries: [entry], nextCursor: 'next-page-cursor' }),
      );
      const useCase = new GetWalletLedgerUseCase(walletRepository, ledgerRepository);

      const result = await useCase.execute({ walletId: 'wallet-1', limit: 50 });

      expect(findById).toHaveBeenCalledWith('wallet-1');
      expect(list).toHaveBeenCalledWith({
        walletId: 'wallet-1',
        currency: 'USD',
        limit: 50,
        cursor: undefined,
      });
      expect(result.entries).toEqual([entry]);
      expect(result.nextCursor).toBe('next-page-cursor');
    });
  });

  describe('happy path — with cursor', () => {
    it('passes the opaque cursor through to the port untouched', async () => {
      const { repository: walletRepository } = buildWalletRepository();
      const { repository: ledgerRepository, list } = buildLedgerRepository();
      const useCase = new GetWalletLedgerUseCase(walletRepository, ledgerRepository);

      await useCase.execute({ walletId: 'wallet-1', limit: 50, cursor: 'opaque-cursor' });

      expect(list).toHaveBeenCalledWith({
        walletId: 'wallet-1',
        currency: 'USD',
        limit: 50,
        cursor: 'opaque-cursor',
      });
    });
  });

  describe('wallet not found', () => {
    it('throws WalletNotFoundError and never calls the ledger port', async () => {
      const { repository: walletRepository } = buildWalletRepository(() => Promise.resolve(null));
      const { repository: ledgerRepository, list } = buildLedgerRepository();
      const useCase = new GetWalletLedgerUseCase(walletRepository, ledgerRepository);

      const error = await useCase
        .execute({ walletId: 'missing-wallet', limit: 50 })
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('invalid limit', () => {
    it.each([0, 101, 1.5, -1])(
      'throws GetWalletLedgerLimitError for limit=%p without touching either port',
      async (limit) => {
        const { repository: walletRepository, findById } = buildWalletRepository();
        const { repository: ledgerRepository, list } = buildLedgerRepository();
        const useCase = new GetWalletLedgerUseCase(walletRepository, ledgerRepository);

        const error = await useCase.execute({ walletId: 'wallet-1', limit }).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(GetWalletLedgerLimitError);
        expect((error as GetWalletLedgerLimitError).code).toBe('VALIDATION_INVALID_LIMIT');
        expect(findById).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      },
    );
  });

  describe('cursor error propagation', () => {
    it('propagates a cursor decode error raised by the port untouched', async () => {
      const cursorError = new FakeCursorError('bad cursor');
      const { repository: walletRepository } = buildWalletRepository();
      const { repository: ledgerRepository } = buildLedgerRepository(() => Promise.reject(cursorError));
      const useCase = new GetWalletLedgerUseCase(walletRepository, ledgerRepository);

      const error = await useCase
        .execute({ walletId: 'wallet-1', limit: 50, cursor: 'garbage' })
        .catch((err: unknown) => err);

      expect(error).toBe(cursorError);
    });
  });
});
