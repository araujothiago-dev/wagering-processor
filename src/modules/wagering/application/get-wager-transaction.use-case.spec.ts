import { describe, expect, it, mock } from 'bun:test';
import { Money } from '../../../shared/money';
import { TransactionNotFoundError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { GetWagerTransactionUseCase } from './get-wager-transaction.use-case';
import type { WagerTransactionRepository } from './ports';

function buildTransaction(): WagerTransaction {
  return WagerTransaction.processed({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.of('25.00', 'BRL'),
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-1',
  });
}

function buildRepository(overrides?: Partial<WagerTransactionRepository>) {
  const findById = mock(overrides?.findById ?? (() => Promise.resolve(null)));
  const findByProviderAndExternalId = mock(
    overrides?.findByProviderAndExternalId ?? (() => Promise.resolve(null)),
  );
  const repository: WagerTransactionRepository = { findById, findByProviderAndExternalId };
  return { repository, findById, findByProviderAndExternalId };
}

describe('GetWagerTransactionUseCase', () => {
  describe('byId', () => {
    it('returns the transaction found by the repository', async () => {
      const transaction = buildTransaction();
      const { repository, findById } = buildRepository({ findById: () => Promise.resolve(transaction) });
      const useCase = new GetWagerTransactionUseCase(repository);

      const result = await useCase.byId('tx-1');

      expect(result).toBe(transaction);
      expect(findById).toHaveBeenCalledWith('tx-1');
    });

    it('throws TransactionNotFoundError when the repository returns null', async () => {
      const { repository } = buildRepository();
      const useCase = new GetWagerTransactionUseCase(repository);

      const error = await useCase.byId('missing-id').catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TransactionNotFoundError);
      expect((error as TransactionNotFoundError).code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('byProviderAndExternalId', () => {
    it('returns the transaction found by the repository', async () => {
      const transaction = buildTransaction();
      const { repository, findByProviderAndExternalId } = buildRepository({
        findByProviderAndExternalId: () => Promise.resolve(transaction),
      });
      const useCase = new GetWagerTransactionUseCase(repository);

      const result = await useCase.byProviderAndExternalId('provider-a', 'transaction-123');

      expect(result).toBe(transaction);
      expect(findByProviderAndExternalId).toHaveBeenCalledWith('provider-a', 'transaction-123');
    });

    it('throws TransactionNotFoundError when the repository returns null', async () => {
      const { repository } = buildRepository();
      const useCase = new GetWagerTransactionUseCase(repository);

      const error = await useCase
        .byProviderAndExternalId('provider-a', 'never-submitted')
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TransactionNotFoundError);
      expect((error as TransactionNotFoundError).code).toBe('TRANSACTION_NOT_FOUND');
    });
  });
});
