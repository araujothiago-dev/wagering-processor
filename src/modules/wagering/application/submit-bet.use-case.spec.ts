import { describe, expect, it, mock } from 'bun:test';
import { Money, MoneyValidationError } from '../../../shared/money';
import { CurrencyMismatchError, InsufficientBalanceError } from '../../wallet/domain/errors';
import { Wallet } from '../../wallet/domain/wallet';
import { IdempotencyKeyConflictError, ReferenceNotFoundError, ReferenceScopeMismatchError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { SubmitBetUseCase, type SubmitBetCommand } from './submit-bet.use-case';
import type { SubmitBetDecide, SubmitBetOutcome, SubmitBetTransactionalWriter, WagerTransactionRepository } from './ports';

const VALID_COMMAND: SubmitBetCommand = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  amount: '30.00',
  currency: 'BRL',
  idempotencyKey: 'provider-a:transaction-123',
};

function buildWallet(balance: string, currency = 'BRL'): Wallet {
  return Wallet.rehydrate({
    id: 'wallet-1',
    playerId: 'player-1',
    currency,
    balance: Money.of(balance, currency),
    version: 1,
  });
}

// Story 2.2 — a repository stub that fails loudly if called when the test doesn't expect a
// reference lookup (BET/LOSS, or WIN with no `referenceExternalTransactionId`) — catches the use
// case accidentally querying when it shouldn't.
function buildRepository(byProviderAndExternalId?: (providerId: string, externalId: string) => Promise<WagerTransaction | null>) {
  const findByProviderAndExternalId = mock(
    byProviderAndExternalId ??
      (() => Promise.reject(new Error('WagerTransactionRepository.findByProviderAndExternalId should not be called'))),
  );
  const findById = mock(() => Promise.reject(new Error('WagerTransactionRepository.findById should not be called')));
  const repository: WagerTransactionRepository = { findById, findByProviderAndExternalId };
  return { repository, findByProviderAndExternalId };
}

function buildWriterInvokingDecide(wallet: Wallet) {
  const submit = mock(async (_walletId: string, decide: SubmitBetDecide): Promise<SubmitBetOutcome> => {
    const decision = decide(wallet);

    if (decision.transaction.status === 'PROCESSED') {
      return {
        transaction: decision.transaction,
        balanceAfter: decision.wallet ? decision.wallet.balance : wallet.balance,
        idempotentReplay: false,
      };
    }

    return { transaction: decision.transaction, idempotentReplay: false };
  });

  const writer: SubmitBetTransactionalWriter = { submit };
  return { writer, submit };
}

function buildWriterReturning(outcome: SubmitBetOutcome) {
  const submit = mock(() => Promise.resolve(outcome));
  const writer: SubmitBetTransactionalWriter = { submit };
  return { writer, submit };
}

function buildWriterRejectingWith(error: Error) {
  const submit = mock(() => Promise.reject(error));
  const writer: SubmitBetTransactionalWriter = { submit };
  return { writer, submit };
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function buildProcessedReference(overrides: Partial<Parameters<typeof WagerTransaction.processed>[0]> = {}): WagerTransaction {
  return WagerTransaction.processed({
    id: 'tx-bet-original',
    providerId: VALID_COMMAND.providerId,
    externalTransactionId: 'bet-external-id',
    playerId: VALID_COMMAND.playerId,
    walletId: VALID_COMMAND.walletId,
    roundId: VALID_COMMAND.roundId,
    gameId: VALID_COMMAND.gameId,
    kind: 'BET',
    money: Money.of('30.00', 'BRL'),
    idempotencyKey: 'provider-a:bet-external-id',
    payloadHash: 'hash-bet',
    ...overrides,
  });
}

describe('SubmitBetUseCase', () => {
  describe('happy path — BET', () => {
    it('debits the wallet and returns PROCESSED with the new balance', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const result = await useCase.execute(VALID_COMMAND);

      expect(result.status).toBe('PROCESSED');
      expect(result.balance.amount).toBe('70.00');
      expect(result.currency).toBe('BRL');
      expect(result.idempotentReplay).toBe(false);
      expect(typeof result.transactionId).toBe('string');
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[0]).toBe('wallet-1');
    });
  });

  describe('insufficient balance', () => {
    it('re-throws InsufficientBalanceError after a committed REJECTED outcome', async () => {
      const { writer } = buildWriterInvokingDecide(buildWallet('10.00'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect(error).toBeInstanceOf(InsufficientBalanceError);
      expect((error as InsufficientBalanceError).code).toBe('INSUFFICIENT_BALANCE');
    });
  });

  describe('currency mismatch', () => {
    it('propagates CurrencyMismatchError thrown out of decide, never a REJECTED outcome', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00', 'USD'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute({ ...VALID_COMMAND, currency: 'BRL' }));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('propagates CurrencyMismatchError for a WIN too', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00', 'USD'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_COMMAND, kind: 'WIN', currency: 'BRL' }),
      );

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('propagates CurrencyMismatchError for a LOSS too', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00', 'USD'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_COMMAND, kind: 'LOSS', currency: 'BRL' }),
      );

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('replay — PROCESSED', () => {
    it('returns the frozen balanceAfter from the original transaction, with idempotentReplay=true', async () => {
      const existing = WagerTransaction.processed({
        id: 'tx-original',
        providerId: VALID_COMMAND.providerId,
        externalTransactionId: VALID_COMMAND.externalTransactionId,
        playerId: VALID_COMMAND.playerId,
        walletId: VALID_COMMAND.walletId,
        roundId: VALID_COMMAND.roundId,
        gameId: VALID_COMMAND.gameId,
        kind: 'BET',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: VALID_COMMAND.idempotencyKey,
        payloadHash: 'hash-1',
      });

      const { writer, submit } = buildWriterReturning({
        transaction: existing,
        balanceAfter: Money.of('40.00', 'BRL'),
        idempotentReplay: true,
      });
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const result = await useCase.execute(VALID_COMMAND);

      expect(result.transactionId).toBe('tx-original');
      expect(result.balance.amount).toBe('40.00');
      expect(result.idempotentReplay).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('replay — REJECTED', () => {
    it('re-throws InsufficientBalanceError without re-evaluating the current balance', async () => {
      const existing = WagerTransaction.rejected({
        id: 'tx-original',
        providerId: VALID_COMMAND.providerId,
        externalTransactionId: VALID_COMMAND.externalTransactionId,
        playerId: VALID_COMMAND.playerId,
        walletId: VALID_COMMAND.walletId,
        roundId: VALID_COMMAND.roundId,
        gameId: VALID_COMMAND.gameId,
        kind: 'BET',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: VALID_COMMAND.idempotencyKey,
        payloadHash: 'hash-1',
        failureCode: 'INSUFFICIENT_BALANCE',
      });

      const { writer } = buildWriterReturning({ transaction: existing, idempotentReplay: true });
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect(error).toBeInstanceOf(InsufficientBalanceError);
    });
  });

  describe('idempotency-key conflict', () => {
    it('propagates IdempotencyKeyConflictError thrown by the writer untouched', async () => {
      const { writer } = buildWriterRejectingWith(new IdempotencyKeyConflictError(VALID_COMMAND.idempotencyKey));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect(error).toBeInstanceOf(IdempotencyKeyConflictError);
    });
  });

  describe('wallet not found', () => {
    it('propagates WalletNotFoundError thrown by the writer untouched', async () => {
      class FakeWalletNotFoundError extends Error {
        readonly code = 'WALLET_NOT_FOUND' as const;
      }
      const { writer } = buildWriterRejectingWith(new FakeWalletNotFoundError('not found'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect((error as { code?: string }).code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('malformed amount', () => {
    it('propagates a Money validation error and never calls the writer', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute({ ...VALID_COMMAND, amount: '1.234' }));

      expect(error).toBeInstanceOf(MoneyValidationError);
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('WIN', () => {
    it('without a reference: credits the wallet and returns PROCESSED with the new balance', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository, findByProviderAndExternalId } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const result = await useCase.execute({ ...VALID_COMMAND, kind: 'WIN', amount: '30.00' });

      expect(result.status).toBe('PROCESSED');
      expect(result.balance.amount).toBe('130.00');
      expect(result.idempotentReplay).toBe(false);
      expect(findByProviderAndExternalId).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('with a valid reference: credits the wallet and records referenceTransactionId', async () => {
      const wallet = buildWallet('100.00');
      const reference = buildProcessedReference();
      const { repository, findByProviderAndExternalId } = buildRepository(() => Promise.resolve(reference));

      const submit = mock(async (_walletId: string, decide: SubmitBetDecide): Promise<SubmitBetOutcome> => {
        const decision = decide(wallet);
        expect(decision.transaction.referenceTransactionId).toBe(reference.id);

        if (decision.transaction.status === 'PROCESSED') {
          return { transaction: decision.transaction, balanceAfter: decision.wallet!.balance, idempotentReplay: false };
        }

        return { transaction: decision.transaction, idempotentReplay: false };
      });
      const writer: SubmitBetTransactionalWriter = { submit };
      const useCase = new SubmitBetUseCase(writer, repository);

      const result = await useCase.execute({
        ...VALID_COMMAND,
        kind: 'WIN',
        amount: '30.00',
        referenceExternalTransactionId: 'bet-external-id',
      });

      expect(result.status).toBe('PROCESSED');
      expect(result.balance.amount).toBe('130.00');
      expect(findByProviderAndExternalId).toHaveBeenCalledWith('provider-a', 'bet-external-id');
    });

    it('with a reference out of scope (different wallet): rejects with ReferenceScopeMismatchError, wallet untouched', async () => {
      const wallet = buildWallet('100.00');
      const reference = buildProcessedReference({ walletId: 'some-other-wallet' });
      const { repository } = buildRepository(() => Promise.resolve(reference));
      const { writer, submit } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'bet-external-id',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect((error as ReferenceScopeMismatchError).code).toBe('REFERENCE_SCOPE_MISMATCH');
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('with a reference out of scope (different round): rejects with ReferenceScopeMismatchError', async () => {
      const wallet = buildWallet('100.00');
      const reference = buildProcessedReference({ roundId: 'some-other-round' });
      const { repository } = buildRepository(() => Promise.resolve(reference));
      const { writer } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'bet-external-id',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
    });

    it('with a reference out of scope (different playerId): rejects with ReferenceScopeMismatchError', async () => {
      const wallet = buildWallet('100.00');
      const reference = buildProcessedReference({ playerId: 'some-other-player' });
      const { repository } = buildRepository(() => Promise.resolve(reference));
      const { writer } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'bet-external-id',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
    });

    it('with a reference out of scope (different currency): rejects with ReferenceScopeMismatchError', async () => {
      const wallet = buildWallet('100.00');
      const reference = buildProcessedReference({ money: Money.of('30.00', 'USD') });
      const { repository } = buildRepository(() => Promise.resolve(reference));
      const { writer } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'bet-external-id',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
    });

    it('with a reference whose kind is not BET (e.g. WIN): rejects with ReferenceScopeMismatchError', async () => {
      const wallet = buildWallet('100.00');
      const reference = buildProcessedReference({ kind: 'WIN' });
      const { repository } = buildRepository(() => Promise.resolve(reference));
      const { writer } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'bet-external-id',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
    });

    it('with a reference whose status is not PROCESSED (e.g. REJECTED): rejects with ReferenceScopeMismatchError', async () => {
      const wallet = buildWallet('100.00');
      const reference = WagerTransaction.rejected({
        id: 'tx-bet-original',
        providerId: VALID_COMMAND.providerId,
        externalTransactionId: 'bet-external-id',
        playerId: VALID_COMMAND.playerId,
        walletId: VALID_COMMAND.walletId,
        roundId: VALID_COMMAND.roundId,
        gameId: VALID_COMMAND.gameId,
        kind: 'BET',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: 'provider-a:bet-external-id',
        payloadHash: 'hash-bet',
        failureCode: 'INSUFFICIENT_BALANCE',
      });
      const { repository } = buildRepository(() => Promise.resolve(reference));
      const { writer } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'bet-external-id',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
    });

    it('with a nonexistent reference: rejects with ReferenceNotFoundError, wallet untouched', async () => {
      const wallet = buildWallet('100.00');
      const { repository, findByProviderAndExternalId } = buildRepository(() => Promise.resolve(null));
      const { writer, submit } = buildWriterInvokingDecide(wallet);
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'never-submitted',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceNotFoundError);
      expect((error as ReferenceNotFoundError).code).toBe('REFERENCE_NOT_FOUND');
      expect(findByProviderAndExternalId).toHaveBeenCalledWith('provider-a', 'never-submitted');
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('replay — PROCESSED with a reference-not-found failureCode re-throws ReferenceNotFoundError', async () => {
      const existing = WagerTransaction.rejected({
        id: 'tx-original',
        providerId: VALID_COMMAND.providerId,
        externalTransactionId: VALID_COMMAND.externalTransactionId,
        playerId: VALID_COMMAND.playerId,
        walletId: VALID_COMMAND.walletId,
        roundId: VALID_COMMAND.roundId,
        gameId: VALID_COMMAND.gameId,
        kind: 'WIN',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: VALID_COMMAND.idempotencyKey,
        payloadHash: 'hash-1',
        failureCode: 'REFERENCE_NOT_FOUND',
      });

      const { writer } = buildWriterReturning({ transaction: existing, idempotentReplay: true });
      const { repository } = buildRepository(() => Promise.resolve(null));
      const useCase = new SubmitBetUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({
          ...VALID_COMMAND,
          kind: 'WIN',
          amount: '30.00',
          referenceExternalTransactionId: 'never-submitted',
        }),
      );

      expect(error).toBeInstanceOf(ReferenceNotFoundError);
    });
  });

  describe('LOSS', () => {
    it('does not touch the wallet: decide never mutates balance, PROCESSED returned with the untouched balance', async () => {
      const wallet = buildWallet('100.00');
      const submit = mock(async (_walletId: string, decide: SubmitBetDecide): Promise<SubmitBetOutcome> => {
        const decision = decide(wallet);
        expect(decision.wallet).toBeUndefined();
        expect(decision.ledgerEntry).toBeUndefined();
        expect(decision.transaction.status).toBe('PROCESSED');

        // Mirrors the writer's real behaviour for a wallet-untouched PROCESSED decision: the
        // wallet's own (unlocked-here) current balance is reported.
        return { transaction: decision.transaction, balanceAfter: wallet.balance, idempotentReplay: false };
      });
      const writer: SubmitBetTransactionalWriter = { submit };
      const { repository, findByProviderAndExternalId } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const result = await useCase.execute({ ...VALID_COMMAND, kind: 'LOSS', amount: '40.00' });

      expect(result.status).toBe('PROCESSED');
      expect(result.balance.amount).toBe('100.00');
      expect(result.idempotentReplay).toBe(false);
      expect(findByProviderAndExternalId).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('replay — PROCESSED reuses the same replay handling as BET/WIN, with idempotentReplay=true', async () => {
      const existing = WagerTransaction.processed({
        id: 'tx-loss-original',
        providerId: VALID_COMMAND.providerId,
        externalTransactionId: VALID_COMMAND.externalTransactionId,
        playerId: VALID_COMMAND.playerId,
        walletId: VALID_COMMAND.walletId,
        roundId: VALID_COMMAND.roundId,
        gameId: VALID_COMMAND.gameId,
        kind: 'LOSS',
        money: Money.of('40.00', 'BRL'),
        idempotencyKey: VALID_COMMAND.idempotencyKey,
        payloadHash: 'hash-loss',
      });

      const { writer, submit } = buildWriterReturning({
        transaction: existing,
        balanceAfter: Money.of('100.00', 'BRL'),
        idempotentReplay: true,
      });
      const { repository } = buildRepository();
      const useCase = new SubmitBetUseCase(writer, repository);

      const result = await useCase.execute({ ...VALID_COMMAND, kind: 'LOSS', amount: '40.00' });

      expect(result.transactionId).toBe('tx-loss-original');
      expect(result.balance.amount).toBe('100.00');
      expect(result.idempotentReplay).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });
});
