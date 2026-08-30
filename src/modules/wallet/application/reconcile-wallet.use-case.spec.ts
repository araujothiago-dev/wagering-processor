import { describe, expect, it, mock } from 'bun:test';
import { Money } from '../../../shared/money';
import { WalletNotFoundError } from '../domain/errors';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { ReconcileWalletUseCase } from './reconcile-wallet.use-case';
import type { WalletLedgerRepository, WalletRepository } from './ports';

function buildWallet(): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'USD',
    balance: Money.of('30.00', 'USD'),
    version: 2,
  });
}

function buildWalletRepository(impl?: (id: string) => Promise<Wallet | null>) {
  const findById = mock(impl ?? (() => Promise.resolve(buildWallet())));
  const repository: WalletRepository = { findById };
  return { repository, findById };
}

function buildLedgerRepository(impl?: (walletId: string, currency: string) => Promise<WalletLedgerEntry[]>) {
  const listAll = mock(impl ?? (() => Promise.resolve([])));
  const list = mock(() => Promise.resolve({ entries: [] }));
  const repository: WalletLedgerRepository = { list, listAll };
  return { repository, listAll, list };
}

describe('ReconcileWalletUseCase', () => {
  describe('happy path', () => {
    it('checks wallet existence, lists every ledger entry, and delegates the comparison to the domain function', async () => {
      const entry = WalletLedgerEntry.credit({
        walletId: 'wallet-1',
        wagerTransactionId: 'tx-1',
        money: Money.of('30.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('30.00', 'USD'),
      });
      const { repository: walletRepository, findById } = buildWalletRepository();
      const { repository: ledgerRepository, listAll } = buildLedgerRepository(() => Promise.resolve([entry]));
      const useCase = new ReconcileWalletUseCase(walletRepository, ledgerRepository);

      const result = await useCase.execute({ walletId: 'wallet-1' });

      expect(findById).toHaveBeenCalledWith('wallet-1');
      expect(listAll).toHaveBeenCalledWith('wallet-1', 'USD');
      expect(result.consistent).toBe(true);
      expect(result.checkedEntries).toBe(1);
      expect(result.storedBalance.amount).toBe('30.00');
    });
  });

  describe('wallet not found', () => {
    it('throws WalletNotFoundError and never lists the ledger', async () => {
      const { repository: walletRepository } = buildWalletRepository(() => Promise.resolve(null));
      const { repository: ledgerRepository, listAll } = buildLedgerRepository();
      const useCase = new ReconcileWalletUseCase(walletRepository, ledgerRepository);

      const error = await useCase.execute({ walletId: 'missing-wallet' }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect(listAll).not.toHaveBeenCalled();
    });
  });
});
