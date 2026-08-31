import { describe, expect, it, mock } from 'bun:test';
import { Money, MoneyValidationError } from '../../../shared/money';
import { CurrencyMismatchError, InsufficientBalanceError } from '../../wallet/domain/errors';
import { Wallet } from '../../wallet/domain/wallet';
import { IdempotencyKeyConflictError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { SubmitBetUseCase, type SubmitBetCommand } from './submit-bet.use-case';
import type { SubmitWagerDecide, SubmitWagerOutcome, SubmitWagerTransactionalWriter } from './ports';

const VALID_COMMAND: SubmitBetCommand = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
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

function buildWriterInvokingDecide(wallet: Wallet) {
  const submit = mock(async (_walletId: string, decide: SubmitWagerDecide): Promise<SubmitWagerOutcome> => {
    const decision = decide(wallet);

    if (decision.transaction.status === 'PROCESSED') {
      return { transaction: decision.transaction, balanceAfter: decision.wallet!.balance, idempotentReplay: false };
    }

    return { transaction: decision.transaction, idempotentReplay: false };
  });

  const writer: SubmitWagerTransactionalWriter = { submit };
  return { writer, submit };
}

function buildWriterReturning(outcome: SubmitWagerOutcome) {
  const submit = mock(() => Promise.resolve(outcome));
  const writer: SubmitWagerTransactionalWriter = { submit };
  return { writer, submit };
}

function buildWriterRejectingWith(error: Error) {
  const submit = mock(() => Promise.reject(error));
  const writer: SubmitWagerTransactionalWriter = { submit };
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

describe('SubmitBetUseCase', () => {
  describe('happy path', () => {
    it('debits the wallet and returns PROCESSED with the new balance', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const useCase = new SubmitBetUseCase(writer);

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
      const useCase = new SubmitBetUseCase(writer);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect(error).toBeInstanceOf(InsufficientBalanceError);
      expect((error as InsufficientBalanceError).code).toBe('INSUFFICIENT_BALANCE');
    });
  });

  describe('currency mismatch', () => {
    it('propagates CurrencyMismatchError thrown out of decide, never a REJECTED outcome', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00', 'USD'));
      const useCase = new SubmitBetUseCase(writer);

      const error = await captureAsyncError(() => useCase.execute({ ...VALID_COMMAND, currency: 'BRL' }));

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
      const useCase = new SubmitBetUseCase(writer);

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
      const useCase = new SubmitBetUseCase(writer);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect(error).toBeInstanceOf(InsufficientBalanceError);
    });
  });

  describe('idempotency-key conflict', () => {
    it('propagates IdempotencyKeyConflictError thrown by the writer untouched', async () => {
      const { writer } = buildWriterRejectingWith(new IdempotencyKeyConflictError(VALID_COMMAND.idempotencyKey));
      const useCase = new SubmitBetUseCase(writer);

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
      const useCase = new SubmitBetUseCase(writer);

      const error = await captureAsyncError(() => useCase.execute(VALID_COMMAND));

      expect((error as { code?: string }).code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('malformed amount', () => {
    it('propagates a Money validation error and never calls the writer', async () => {
      const { writer, submit } = buildWriterInvokingDecide(buildWallet('100.00'));
      const useCase = new SubmitBetUseCase(writer);

      const error = await captureAsyncError(() => useCase.execute({ ...VALID_COMMAND, amount: '1.234' }));

      expect(error).toBeInstanceOf(MoneyValidationError);
      expect(submit).not.toHaveBeenCalled();
    });
  });
});
