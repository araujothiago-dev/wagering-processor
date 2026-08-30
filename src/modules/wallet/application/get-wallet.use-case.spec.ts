import { describe, expect, it, mock } from 'bun:test';
import { Money } from '../../../shared/money';
import { WalletNotFoundError } from '../domain/errors';
import { Wallet } from '../domain/wallet';
import { GetWalletUseCase } from './get-wallet.use-case';
import type { WalletRepository } from './ports';

function buildRepository(impl?: (id: string) => Promise<Wallet | null>) {
  const findById = mock(impl ?? (() => Promise.resolve(null)));
  const repository: WalletRepository = { findById };
  return { repository, findById };
}

describe('GetWalletUseCase', () => {
  describe('happy path', () => {
    it('returns the wallet found by the repository, unchanged', async () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balance: Money.of('50.00', 'USD'),
        version: 3,
      });
      const { repository, findById } = buildRepository(() => Promise.resolve(wallet));
      const useCase = new GetWalletUseCase(repository);

      const result = await useCase.execute({ walletId: 'wallet-1' });

      expect(result).toBe(wallet);
      expect(findById).toHaveBeenCalledWith('wallet-1');
    });
  });

  describe('not found', () => {
    it('throws WalletNotFoundError when the repository returns null', async () => {
      const { repository } = buildRepository(() => Promise.resolve(null));
      const useCase = new GetWalletUseCase(repository);

      const error = await useCase.execute({ walletId: 'missing-wallet' }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect((error as WalletNotFoundError).code).toBe('WALLET_NOT_FOUND');
    });
  });
});
