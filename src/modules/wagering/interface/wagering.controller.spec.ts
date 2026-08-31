import { describe, expect, it, mock } from 'bun:test';
import { Money } from '../../../shared/money';
import { CurrencyMismatchError, InsufficientBalanceError, WalletNotFoundError } from '../../wallet/domain/errors';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import { SubmitBetUseCase } from '../application/submit-bet.use-case';
import type {
  SubmitBetDecide,
  SubmitBetOutcome,
  SubmitBetTransactionalWriter,
  WagerTransactionRepository,
} from '../application/ports';
import { IdempotencyKeyConflictError, TransactionNotFoundError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { WageringController, WageringRequestValidationError } from './wagering.controller';

const WALLET_ID = '11111111-1111-1111-1111-111111111111';
const IDEMPOTENCY_KEY = 'provider-a:transaction-123';

const VALID_BODY = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: WALLET_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  amount: '25.00',
  currency: 'BRL',
};

function buildController(options?: {
  submit?: (walletId: string, decide: SubmitBetDecide) => Promise<SubmitBetOutcome>;
  findById?: (id: string) => Promise<WagerTransaction | null>;
  findByProviderAndExternalId?: (providerId: string, externalTransactionId: string) => Promise<WagerTransaction | null>;
}) {
  const submit = mock(options?.submit ?? (() => Promise.reject(new Error('submit not configured'))));
  const writer: SubmitBetTransactionalWriter = { submit };

  const findById = mock(options?.findById ?? (() => Promise.resolve(null)));
  const findByProviderAndExternalId = mock(
    options?.findByProviderAndExternalId ?? (() => Promise.resolve(null)),
  );
  const repository: WagerTransactionRepository = { findById, findByProviderAndExternalId };

  const controller = new WageringController(
    new SubmitBetUseCase(writer),
    new GetWagerTransactionUseCase(repository),
  );
  return { controller, submit, findById, findByProviderAndExternalId };
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('WageringController', () => {
  describe('submit — success', () => {
    it('maps a PROCESSED outcome to the response body', async () => {
      const transaction = WagerTransaction.processed({
        id: 'tx-1',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: 'player-1',
        walletId: WALLET_ID,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.of('25.00', 'BRL'),
        idempotencyKey: IDEMPOTENCY_KEY,
        payloadHash: 'hash-1',
      });
      const { controller, submit } = buildController({
        submit: () => Promise.resolve({ transaction, balanceAfter: Money.of('75.00', 'BRL'), idempotentReplay: false }),
      });

      const response = await controller.submit(VALID_BODY, IDEMPOTENCY_KEY);

      expect(response).toEqual({
        transactionId: 'tx-1',
        status: 'PROCESSED',
        balance: '75.00',
        currency: 'BRL',
        idempotentReplay: false,
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0]?.[0]).toBe(WALLET_ID);
    });

    it('maps idempotentReplay=true through untouched', async () => {
      const transaction = WagerTransaction.processed({
        id: 'tx-original',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: 'player-1',
        walletId: WALLET_ID,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.of('25.00', 'BRL'),
        idempotencyKey: IDEMPOTENCY_KEY,
        payloadHash: 'hash-1',
      });
      const { controller } = buildController({
        submit: () => Promise.resolve({ transaction, balanceAfter: Money.of('40.00', 'BRL'), idempotentReplay: true }),
      });

      const response = await controller.submit(VALID_BODY, IDEMPOTENCY_KEY);

      expect(response.idempotentReplay).toBe(true);
      expect(response.balance).toBe('40.00');
    });
  });

  describe('submit — missing Idempotency-Key header', () => {
    it('rejects an absent header', async () => {
      const { controller, submit } = buildController();

      const error = await captureAsyncError(() => controller.submit(VALID_BODY, undefined));

      expect(error).toBeInstanceOf(WageringRequestValidationError);
      expect((error as WageringRequestValidationError).code).toBe('VALIDATION_MISSING_IDEMPOTENCY_KEY');
      expect(submit).not.toHaveBeenCalled();
    });

    it('rejects an empty header', async () => {
      const { controller, submit } = buildController();

      const error = await captureAsyncError(() => controller.submit(VALID_BODY, ''));

      expect(error).toBeInstanceOf(WageringRequestValidationError);
      expect((error as WageringRequestValidationError).code).toBe('VALIDATION_MISSING_IDEMPOTENCY_KEY');
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('submit — malformed body', () => {
    it('rejects a non-object body', async () => {
      const { controller, submit } = buildController();

      const error = await captureAsyncError(() => controller.submit(null, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(WageringRequestValidationError);
      expect((error as WageringRequestValidationError).code).toBe('VALIDATION_INVALID_REQUEST');
      expect(submit).not.toHaveBeenCalled();
    });

    it.each([
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'amount',
      'currency',
    ])('rejects a missing "%s"', async (field) => {
      const { controller, submit } = buildController();
      const body = { ...VALID_BODY } as Record<string, unknown>;
      delete body[field];

      const error = await captureAsyncError(() => controller.submit(body, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(WageringRequestValidationError);
      expect((error as WageringRequestValidationError).code).toBe('VALIDATION_INVALID_REQUEST');
      expect(submit).not.toHaveBeenCalled();
    });

    it('rejects an empty string field the same as a missing one', async () => {
      const { controller, submit } = buildController();

      const error = await captureAsyncError(() => controller.submit({ ...VALID_BODY, gameId: '' }, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(WageringRequestValidationError);
      expect((error as WageringRequestValidationError).code).toBe('VALIDATION_INVALID_REQUEST');
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('submit — unsupported kind', () => {
    it('rejects kind !== BET as VALIDATION_UNSUPPORTED_KIND', async () => {
      const { controller, submit } = buildController();

      const error = await captureAsyncError(() => controller.submit({ ...VALID_BODY, kind: 'WIN' }, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(WageringRequestValidationError);
      expect((error as WageringRequestValidationError).code).toBe('VALIDATION_UNSUPPORTED_KIND');
      expect(submit).not.toHaveBeenCalled();
    });
  });

  describe('submit — propagated domain errors', () => {
    it('propagates InsufficientBalanceError untouched', async () => {
      const { controller } = buildController({
        submit: () => Promise.reject(new InsufficientBalanceError(WALLET_ID, Money.of('25.00', 'BRL'))),
      });

      const error = await captureAsyncError(() => controller.submit(VALID_BODY, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(InsufficientBalanceError);
    });

    it('propagates WalletNotFoundError untouched', async () => {
      const { controller } = buildController({
        submit: () => Promise.reject(new WalletNotFoundError(WALLET_ID)),
      });

      const error = await captureAsyncError(() => controller.submit(VALID_BODY, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(WalletNotFoundError);
    });

    it('propagates CurrencyMismatchError untouched', async () => {
      const { controller } = buildController({
        submit: () => Promise.reject(new CurrencyMismatchError('USD', 'BRL')),
      });

      const error = await captureAsyncError(() => controller.submit(VALID_BODY, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(CurrencyMismatchError);
    });

    it('propagates IdempotencyKeyConflictError untouched', async () => {
      const { controller } = buildController({
        submit: () => Promise.reject(new IdempotencyKeyConflictError(IDEMPOTENCY_KEY)),
      });

      const error = await captureAsyncError(() => controller.submit(VALID_BODY, IDEMPOTENCY_KEY));

      expect(error).toBeInstanceOf(IdempotencyKeyConflictError);
    });
  });

  describe('getById', () => {
    it('maps a found transaction to the response body', async () => {
      const transaction = WagerTransaction.processed({
        id: 'tx-1',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-123',
        playerId: 'player-1',
        walletId: WALLET_ID,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.of('25.00', 'BRL'),
        idempotencyKey: IDEMPOTENCY_KEY,
        payloadHash: 'hash-1',
      });
      const { controller, findById } = buildController({ findById: () => Promise.resolve(transaction) });

      const response = await controller.getById('tx-1');

      expect(findById).toHaveBeenCalledWith('tx-1');
      expect(response).toEqual({
        transactionId: 'tx-1',
        status: 'PROCESSED',
        kind: 'BET',
        amount: '25.00',
        currency: 'BRL',
        referenceTransactionId: undefined,
      });
    });

    it('propagates TransactionNotFoundError when no row matches', async () => {
      const { controller } = buildController({ findById: () => Promise.resolve(null) });

      const error = await captureAsyncError(() => controller.getById('missing-id'));

      expect(error).toBeInstanceOf(TransactionNotFoundError);
      expect((error as TransactionNotFoundError).code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('getByProviderAndExternalId', () => {
    it('maps a found transaction to the response body', async () => {
      const transaction = WagerTransaction.rejected({
        id: 'tx-2',
        providerId: 'provider-a',
        externalTransactionId: 'transaction-456',
        playerId: 'player-1',
        walletId: WALLET_ID,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: Money.of('999.00', 'BRL'),
        idempotencyKey: 'provider-a:transaction-456',
        payloadHash: 'hash-2',
        failureCode: 'INSUFFICIENT_BALANCE',
      });
      const { controller, findByProviderAndExternalId } = buildController({
        findByProviderAndExternalId: () => Promise.resolve(transaction),
      });

      const response = await controller.getByProviderAndExternalId('provider-a', 'transaction-456');

      expect(findByProviderAndExternalId).toHaveBeenCalledWith('provider-a', 'transaction-456');
      expect(response).toEqual({
        transactionId: 'tx-2',
        status: 'REJECTED',
        kind: 'BET',
        amount: '999.00',
        currency: 'BRL',
        referenceTransactionId: undefined,
      });
    });

    it('propagates TransactionNotFoundError when no row matches', async () => {
      const { controller } = buildController({
        findByProviderAndExternalId: () => Promise.resolve(null),
      });

      const error = await captureAsyncError(() =>
        controller.getByProviderAndExternalId('provider-a', 'never-submitted'),
      );

      expect(error).toBeInstanceOf(TransactionNotFoundError);
      expect((error as TransactionNotFoundError).code).toBe('TRANSACTION_NOT_FOUND');
    });
  });
});
