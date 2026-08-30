import { describe, expect, it, mock } from 'bun:test';
import { Money, MoneyValidationError } from '../../../shared/money';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { GetWalletLedgerUseCase } from '../application/get-wallet-ledger.use-case';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';
import type {
  CreateWalletTransactionalWriter,
  CreateWalletWriteCommand,
  ListWalletLedgerParams,
  ListWalletLedgerResult,
  WalletLedgerRepository,
  WalletRepository,
} from '../application/ports';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../domain/errors';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WalletController, WalletRequestValidationError } from './wallet.controller';

const VALID_WALLET_ID = '11111111-1111-1111-1111-111111111111';

function buildWallet(): Wallet {
  return Wallet.rehydrate({
    id: VALID_WALLET_ID,
    playerId: 'player-1',
    currency: 'USD',
    balance: Money.of('50.00', 'USD'),
    version: 2,
  });
}

function buildController(options?: {
  write?: (command: CreateWalletWriteCommand) => Promise<void>;
  findById?: (id: string) => Promise<Wallet | null>;
  list?: (params: ListWalletLedgerParams) => Promise<ListWalletLedgerResult>;
  listAll?: (walletId: string, currency: string) => Promise<WalletLedgerEntry[]>;
}) {
  const write = mock(options?.write ?? (() => Promise.resolve()));
  const writer: CreateWalletTransactionalWriter = { write };

  const findById = mock(options?.findById ?? (() => Promise.resolve(buildWallet())));
  const walletRepository: WalletRepository = { findById };

  const list = mock(options?.list ?? (() => Promise.resolve({ entries: [] })));
  const listAll = mock(options?.listAll ?? (() => Promise.resolve([])));
  const ledgerRepository: WalletLedgerRepository = { list, listAll };

  const controller = new WalletController(
    new CreateWalletUseCase(writer),
    new GetWalletUseCase(walletRepository),
    new GetWalletLedgerUseCase(walletRepository, ledgerRepository),
    new ReconcileWalletUseCase(walletRepository, ledgerRepository),
  );

  return { controller, write, findById, list, listAll };
}

async function captureAsyncError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('WalletController', () => {
  describe('create — valid requests', () => {
    it('creates a wallet without an initial balance', async () => {
      const { controller, write } = buildController();

      const response = await controller.create({ playerId: 'player-1', currency: 'USD' });

      expect(response).toEqual({
        id: response.id,
        playerId: 'player-1',
        currency: 'USD',
        balance: '0.00',
        version: 1,
      });
      expect(typeof response.id).toBe('string');
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('creates a wallet with an initial balance', async () => {
      const { controller } = buildController();

      const response = await controller.create({
        playerId: 'player-1',
        currency: 'USD',
        initialBalance: '50.00',
      });

      expect(response.balance).toBe('50.00');
      expect(response.version).toBe(1);
    });
  });

  describe('create — malformed requests', () => {
    it('rejects a non-object body', async () => {
      const { controller, write } = buildController();

      const error = await captureAsyncError(() => controller.create(null));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect((error as WalletRequestValidationError).code).toBe('VALIDATION_INVALID_REQUEST');
      expect(write).not.toHaveBeenCalled();
    });

    it('rejects a missing playerId', async () => {
      const { controller, write } = buildController();

      const error = await captureAsyncError(() => controller.create({ currency: 'USD' }));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect(write).not.toHaveBeenCalled();
    });

    it('rejects a missing currency', async () => {
      const { controller, write } = buildController();

      const error = await captureAsyncError(() => controller.create({ playerId: 'player-1' }));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect(write).not.toHaveBeenCalled();
    });

    it('rejects an initialBalance that is not a string', async () => {
      const { controller, write } = buildController();

      const error = await captureAsyncError(() =>
        controller.create({ playerId: 'player-1', currency: 'USD', initialBalance: 50 }),
      );

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect(write).not.toHaveBeenCalled();
    });
  });

  describe('create — propagated domain errors', () => {
    it('propagates a Money validation error for a malformed initialBalance string', async () => {
      const { controller, write } = buildController();

      const error = await captureAsyncError(() =>
        controller.create({ playerId: 'player-1', currency: 'USD', initialBalance: '-1.00' }),
      );

      expect(error).toBeInstanceOf(MoneyValidationError);
      expect(write).not.toHaveBeenCalled();
    });

    it('propagates WalletAlreadyExistsError from the use case untouched', async () => {
      const { controller } = buildController({
        write: () => Promise.reject(new WalletAlreadyExistsError('player-1', 'USD')),
      });

      const error = await captureAsyncError(() =>
        controller.create({ playerId: 'player-1', currency: 'USD' }),
      );

      expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    });
  });

  describe('getWallet — valid requests', () => {
    it('returns the wallet found by the use case', async () => {
      const { controller, findById } = buildController();

      const response = await controller.getWallet(VALID_WALLET_ID);

      expect(findById).toHaveBeenCalledWith(VALID_WALLET_ID);
      expect(response).toEqual({
        id: VALID_WALLET_ID,
        playerId: 'player-1',
        currency: 'USD',
        balance: '50.00',
        version: 2,
      });
    });
  });

  describe('getWallet — malformed walletId', () => {
    it('rejects a non-UUID walletId as VALIDATION_INVALID_WALLET_ID without querying', async () => {
      const { controller, findById } = buildController();

      const error = await captureAsyncError(() => controller.getWallet('not-a-uuid'));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect((error as WalletRequestValidationError).code).toBe('VALIDATION_INVALID_WALLET_ID');
      expect(findById).not.toHaveBeenCalled();
    });
  });

  describe('getWallet — not found', () => {
    it('propagates WalletNotFoundError for a well-formed walletId with no wallet', async () => {
      const { controller } = buildController({ findById: () => Promise.resolve(null) });

      const error = await captureAsyncError(() => controller.getWallet(VALID_WALLET_ID));

      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect((error as WalletNotFoundError).code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('getLedger — valid requests', () => {
    it('returns entries mapped to the exact response shape, defaulting limit to 50', async () => {
      const entry = WalletLedgerEntry.rehydrate({
        id: 'entry-1',
        walletId: VALID_WALLET_ID,
        wagerTransactionId: 'tx-1',
        direction: 'CREDIT',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('50.00', 'USD'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const { controller, list } = buildController({
        list: () => Promise.resolve({ entries: [entry], nextCursor: 'opaque-cursor' }),
      });

      const response = await controller.getLedger(VALID_WALLET_ID);

      expect(list).toHaveBeenCalledWith({ walletId: VALID_WALLET_ID, currency: 'USD', limit: 50, cursor: undefined });
      expect(response).toEqual({
        entries: [
          {
            direction: 'CREDIT',
            money: '50.00',
            balanceBefore: '0.00',
            balanceAfter: '50.00',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'opaque-cursor',
      });
      // Never leaks `id`/`wagerTransactionId` (spec "Never").
      expect(response.entries[0]).not.toHaveProperty('id');
      expect(response.entries[0]).not.toHaveProperty('wagerTransactionId');
    });

    it('passes an explicit limit and cursor through', async () => {
      const { controller, list } = buildController();

      await controller.getLedger(VALID_WALLET_ID, '10', 'opaque-cursor');

      expect(list).toHaveBeenCalledWith({
        walletId: VALID_WALLET_ID,
        currency: 'USD',
        limit: 10,
        cursor: 'opaque-cursor',
      });
    });
  });

  describe('getLedger — malformed walletId', () => {
    it('rejects a non-UUID walletId without querying', async () => {
      const { controller, findById, list } = buildController();

      const error = await captureAsyncError(() => controller.getLedger('not-a-uuid'));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect((error as WalletRequestValidationError).code).toBe('VALIDATION_INVALID_WALLET_ID');
      expect(findById).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('getLedger — invalid limit', () => {
    it.each(['0', '101', 'abc'])('rejects limit=%s as VALIDATION_INVALID_LIMIT', async (limit) => {
      const { controller, findById, list } = buildController();

      const error = await captureAsyncError(() => controller.getLedger(VALID_WALLET_ID, limit));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect((error as WalletRequestValidationError).code).toBe('VALIDATION_INVALID_LIMIT');
      // A malformed `limit` must short-circuit before any repository call — wallet existence
      // included, not just the ledger listing.
      expect(findById).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('getLedger — not found', () => {
    it('propagates WalletNotFoundError for a well-formed walletId with no wallet', async () => {
      const { controller, list } = buildController({ findById: () => Promise.resolve(null) });

      const error = await captureAsyncError(() => controller.getLedger(VALID_WALLET_ID));

      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('getLedger — cursor error propagation', () => {
    it('propagates a cursor error raised by the port untouched', async () => {
      class FakeCursorError extends Error {
        readonly code = 'VALIDATION_INVALID_CURSOR' as const;
      }
      const cursorError = new FakeCursorError('bad cursor');
      const { controller } = buildController({ list: () => Promise.reject(cursorError) });

      const error = await captureAsyncError(() => controller.getLedger(VALID_WALLET_ID, undefined, 'garbage'));

      expect(error).toBe(cursorError);
    });
  });

  describe('reconcile — valid requests', () => {
    it('returns the reconciliation result mapped to the exact flat response shape', async () => {
      const entry = WalletLedgerEntry.credit({
        walletId: VALID_WALLET_ID,
        wagerTransactionId: 'tx-1',
        money: Money.of('50.00', 'USD'),
        balanceBefore: Money.zero('USD'),
        balanceAfter: Money.of('50.00', 'USD'),
      });
      const { controller, listAll } = buildController({ listAll: () => Promise.resolve([entry]) });

      const response = await controller.reconcile(VALID_WALLET_ID);

      expect(listAll).toHaveBeenCalledWith(VALID_WALLET_ID, 'USD');
      expect(response).toEqual({
        storedBalance: '50.00',
        calculatedBalance: '50.00',
        difference: '0.00',
        consistent: true,
        checkedEntries: 1,
      });
      expect(response).not.toHaveProperty('currency');
    });

    it('reports consistent=false without correcting anything when the ledger diverges', async () => {
      const { controller } = buildController({ listAll: () => Promise.resolve([]) });

      const response = await controller.reconcile(VALID_WALLET_ID);

      expect(response.consistent).toBe(false);
      expect(response.storedBalance).toBe('50.00');
      expect(response.calculatedBalance).toBe('0.00');
      expect(response.difference).toBe('50.00');
      expect(response.checkedEntries).toBe(0);
    });
  });

  describe('reconcile — malformed walletId', () => {
    it('rejects a non-UUID walletId as VALIDATION_INVALID_WALLET_ID without querying', async () => {
      const { controller, findById, listAll } = buildController();

      const error = await captureAsyncError(() => controller.reconcile('not-a-uuid'));

      expect(error).toBeInstanceOf(WalletRequestValidationError);
      expect((error as WalletRequestValidationError).code).toBe('VALIDATION_INVALID_WALLET_ID');
      expect(findById).not.toHaveBeenCalled();
      expect(listAll).not.toHaveBeenCalled();
    });
  });

  describe('reconcile — not found', () => {
    it('propagates WalletNotFoundError for a well-formed walletId with no wallet', async () => {
      const { controller, listAll } = buildController({ findById: () => Promise.resolve(null) });

      const error = await captureAsyncError(() => controller.reconcile(VALID_WALLET_ID));

      expect(error).toBeInstanceOf(WalletNotFoundError);
      expect(listAll).not.toHaveBeenCalled();
    });
  });
});
