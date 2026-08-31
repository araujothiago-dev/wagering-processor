import { describe, expect, it, mock } from 'bun:test';
import { Money, MoneyValidationError } from '../../../shared/money';
import { CurrencyMismatchError } from '../../wallet/domain/errors';
import { Wallet } from '../../wallet/domain/wallet';
import { IdempotencyKeyConflictError, ReferenceScopeMismatchError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { SubmitWinLossUseCase, type SubmitWinLossCommand } from './submit-win-loss.use-case';
import type { SubmitWagerDecide, SubmitWagerOutcome, WagerTransactionRepository } from './ports';

const VALID_WIN_COMMAND: SubmitWinLossCommand = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-win-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'WIN',
  amount: '30.00',
  currency: 'BRL',
  idempotencyKey: 'provider-a:transaction-win-1',
};

const VALID_LOSS_COMMAND: SubmitWinLossCommand = {
  ...VALID_WIN_COMMAND,
  externalTransactionId: 'transaction-loss-1',
  kind: 'LOSS',
  idempotencyKey: 'provider-a:transaction-loss-1',
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

function buildWriterInvokingDecide(wallet: Wallet) {
  const submit = mock(async (_walletId: string, decide: SubmitWagerDecide): Promise<SubmitWagerOutcome> => {
    const decision = decide(wallet);

    if (decision.transaction.status === 'REJECTED') {
      // Mirrors the real writer's REJECTED branch — committed, no balanceAfter.
      return { transaction: decision.transaction, idempotentReplay: false };
    }

    if (decision.wallet) {
      return { transaction: decision.transaction, balanceAfter: decision.wallet.balance, idempotentReplay: false };
    }

    // No wallet in the decision (LOSS) — mirrors the real writer's fallback to the locked
    // wallet's own (unchanged) balance.
    return { transaction: decision.transaction, balanceAfter: wallet.balance, idempotentReplay: false };
  });

  return { writer: { submit }, submit };
}

function buildWriterRejectingWith(error: Error) {
  const submit = mock(() => Promise.reject(error));
  return { writer: { submit }, submit };
}

function buildReferenceRepository(impl?: (providerId: string, externalId: string) => Promise<WagerTransaction | null>) {
  const findByProviderAndExternalId = mock(impl ?? (() => Promise.resolve(null)));
  const findById = mock(() => Promise.resolve(null));
  const repository: WagerTransactionRepository = { findById, findByProviderAndExternalId };
  return { repository, findByProviderAndExternalId };
}

function buildReferencedBet(overrides?: Partial<Parameters<typeof WagerTransaction.processed>[0]>): WagerTransaction {
  return WagerTransaction.processed({
    id: 'tx-bet-original',
    providerId: 'provider-a',
    externalTransactionId: 'ext-bet-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: Money.of('30.00', 'BRL'),
    idempotencyKey: 'provider-a:ext-bet-1',
    payloadHash: 'hash-bet',
    ...overrides,
  });
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('SubmitWinLossUseCase', () => {
  describe('WIN — happy path, no reference', () => {
    it('credits the wallet and returns PROCESSED with the new balance', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository, findByProviderAndExternalId } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const result = await useCase.execute(VALID_WIN_COMMAND);

      expect(result.status).toBe('PROCESSED');
      expect(result.balance.amount).toBe('130.00');
      expect(result.currency).toBe('BRL');
      expect(result.idempotentReplay).toBe(false);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(findByProviderAndExternalId).not.toHaveBeenCalled();
    });
  });

  describe('LOSS — happy path', () => {
    it('never touches the wallet and returns PROCESSED with the unchanged balance', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository, findByProviderAndExternalId } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const result = await useCase.execute(VALID_LOSS_COMMAND);

      expect(result.status).toBe('PROCESSED');
      expect(result.balance.amount).toBe('100.00');
      expect(result.idempotentReplay).toBe(false);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(findByProviderAndExternalId).not.toHaveBeenCalled();
    });

    it('ignores a referenceExternalTransactionId if one is given for a LOSS', async () => {
      const { writer } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository, findByProviderAndExternalId } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase(writer, repository);

      await useCase.execute({ ...VALID_LOSS_COMMAND, referenceExternalTransactionId: 'ext-bet-1' });

      expect(findByProviderAndExternalId).not.toHaveBeenCalled();
    });
  });

  describe('WIN — with a valid reference', () => {
    it('resolves the reference and carries its internal id onto the new transaction', async () => {
      const referencedBet = buildReferencedBet();
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository, findByProviderAndExternalId } = buildReferenceRepository(() =>
        Promise.resolve(referencedBet),
      );
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const result = await useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-bet-1' });

      expect(result.status).toBe('PROCESSED');
      expect(findByProviderAndExternalId).toHaveBeenCalledWith('provider-a', 'ext-bet-1');
      expect(submit).toHaveBeenCalledTimes(1);
      // The `decide` callback captured the resolved reference — assert via the transaction the
      // writer stub actually persisted.
      const decideArg = submit.mock.calls[0]?.[1] as SubmitWagerDecide;
      const decision = decideArg(buildWallet('100.00'));
      expect(decision.transaction.referenceTransactionId).toBe('tx-bet-original');
    });
  });

  describe('WIN — reference not found', () => {
    it('commits a REJECTED row, throws ReferenceScopeMismatchError, and never touches the wallet', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildReferenceRepository(() => Promise.resolve(null));
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-missing' }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect((error as ReferenceScopeMismatchError).code).toBe('REFERENCE_SCOPE_MISMATCH');
      // The rejection is committed by the writer (idempotent, auditable) — never skipped.
      expect(submit).toHaveBeenCalledTimes(1);
      const decideArg = submit.mock.calls[0]?.[1] as SubmitWagerDecide;
      const decision = decideArg(buildWallet('100.00'));
      expect(decision.transaction.status).toBe('REJECTED');
      expect(decision.transaction.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
      expect(decision.transaction.referenceTransactionId).toBeUndefined();
      expect(decision.wallet).toBeUndefined();
    });
  });

  describe('WIN — reference wrong scope', () => {
    it.each([
      ['playerId', { playerId: 'someone-else' }],
      ['walletId', { walletId: 'some-other-wallet' }],
      ['roundId', { roundId: 'some-other-round' }],
    ] as const)('rejects a mismatched %s as REFERENCE_SCOPE_MISMATCH', async (_field, overrides) => {
      const referencedBet = buildReferencedBet(overrides);
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildReferenceRepository(() => Promise.resolve(referencedBet));
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-bet-1' }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('rejects a mismatched currency as REFERENCE_SCOPE_MISMATCH', async () => {
      const referencedBet = buildReferencedBet({ money: Money.of('30.00', 'USD') });
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildReferenceRepository(() => Promise.resolve(referencedBet));
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-bet-1' }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('rejects a reference to a non-BET kind as REFERENCE_SCOPE_MISMATCH', async () => {
      const referencedWin = buildReferencedBet({ kind: 'WIN' });
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildReferenceRepository(() => Promise.resolve(referencedWin));
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-bet-1' }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('rejects a reference to a REJECTED BET as REFERENCE_SCOPE_MISMATCH', async () => {
      const rejectedBet = WagerTransaction.rejected({
        id: 'tx-bet-rejected',
        providerId: 'provider-a',
        externalTransactionId: 'ext-bet-1',
        playerId: 'player-1',
        walletId: 'wallet-1',
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: 'provider-a:ext-bet-1',
        payloadHash: 'hash-bet',
        failureCode: 'INSUFFICIENT_BALANCE',
      });
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildReferenceRepository(() => Promise.resolve(rejectedBet));
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-bet-1' }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('records the found-but-out-of-scope row id on the REJECTED transaction for audit', async () => {
      const referencedBet = buildReferencedBet({ roundId: 'some-other-round' });
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository } = buildReferenceRepository(() => Promise.resolve(referencedBet));
      const useCase = new SubmitWinLossUseCase(writer, repository);

      await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-bet-1' }),
      );

      const decideArg = submit.mock.calls[0]?.[1] as SubmitWagerDecide;
      const decision = decideArg(buildWallet('100.00'));
      expect(decision.transaction.referenceTransactionId).toBe('tx-bet-original');
    });
  });

  describe('WIN — reference mismatch, idempotent replay', () => {
    it('re-throws ReferenceScopeMismatchError from the replayed REJECTED row without re-querying the reference', async () => {
      const rejected = WagerTransaction.rejected({
        id: 'tx-original',
        providerId: VALID_WIN_COMMAND.providerId,
        externalTransactionId: VALID_WIN_COMMAND.externalTransactionId,
        playerId: VALID_WIN_COMMAND.playerId,
        walletId: VALID_WIN_COMMAND.walletId,
        roundId: VALID_WIN_COMMAND.roundId,
        gameId: VALID_WIN_COMMAND.gameId,
        kind: 'WIN',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: VALID_WIN_COMMAND.idempotencyKey,
        payloadHash: 'hash-1',
        failureCode: 'REFERENCE_SCOPE_MISMATCH',
      });
      const submit = mock(() => Promise.resolve({ transaction: rejected, idempotentReplay: true }));
      const { repository } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase({ submit }, repository);

      const error = await captureAsyncError(() =>
        useCase.execute({ ...VALID_WIN_COMMAND, referenceExternalTransactionId: 'ext-missing' }),
      );

      expect(error).toBeInstanceOf(ReferenceScopeMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('currency mismatch', () => {
    it('propagates CurrencyMismatchError thrown out of decide, never a REJECTED-shaped outcome', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00', 'USD'));
      const { repository } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute({ ...VALID_WIN_COMMAND, currency: 'BRL' }));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency-key conflict', () => {
    it('propagates IdempotencyKeyConflictError thrown by the writer untouched', async () => {
      const { writer } = buildWriterRejectingWith(new IdempotencyKeyConflictError(VALID_WIN_COMMAND.idempotencyKey));
      const { repository } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute(VALID_WIN_COMMAND));

      expect(error).toBeInstanceOf(IdempotencyKeyConflictError);
    });
  });

  describe('malformed amount', () => {
    it('propagates a Money validation error and never calls the writer or the repository', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const { repository, findByProviderAndExternalId } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase(writer, repository);

      const error = await captureAsyncError(() => useCase.execute({ ...VALID_WIN_COMMAND, amount: '1.234' }));

      expect(error).toBeInstanceOf(MoneyValidationError);
      expect(submit).not.toHaveBeenCalled();
      expect(findByProviderAndExternalId).not.toHaveBeenCalled();
    });
  });

  describe('replay — PROCESSED', () => {
    it('returns the frozen balanceAfter from the original transaction, with idempotentReplay=true', async () => {
      const existing = WagerTransaction.processed({
        id: 'tx-original',
        providerId: VALID_WIN_COMMAND.providerId,
        externalTransactionId: VALID_WIN_COMMAND.externalTransactionId,
        playerId: VALID_WIN_COMMAND.playerId,
        walletId: VALID_WIN_COMMAND.walletId,
        roundId: VALID_WIN_COMMAND.roundId,
        gameId: VALID_WIN_COMMAND.gameId,
        kind: 'WIN',
        money: Money.of('30.00', 'BRL'),
        idempotencyKey: VALID_WIN_COMMAND.idempotencyKey,
        payloadHash: 'hash-1',
      });
      const submit = mock(() =>
        Promise.resolve({ transaction: existing, balanceAfter: Money.of('160.00', 'BRL'), idempotentReplay: true }),
      );
      const { repository } = buildReferenceRepository();
      const useCase = new SubmitWinLossUseCase({ submit }, repository);

      const result = await useCase.execute(VALID_WIN_COMMAND);

      expect(result.transactionId).toBe('tx-original');
      expect(result.balance.amount).toBe('160.00');
      expect(result.idempotentReplay).toBe(true);
    });
  });
});
