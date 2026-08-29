import { describe, expect, it, mock } from 'bun:test';
import { MoneyValidationError } from '../../../shared/money';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import type { CreateWalletTransactionalWriter, CreateWalletWriteCommand } from '../application/ports';
import { WalletAlreadyExistsError } from '../domain/errors';
import { WalletController, WalletRequestValidationError } from './wallet.controller';

function buildController(impl?: (command: CreateWalletWriteCommand) => Promise<void>) {
  const write = mock(impl ?? (() => Promise.resolve()));
  const writer: CreateWalletTransactionalWriter = { write };
  const controller = new WalletController(new CreateWalletUseCase(writer));
  return { controller, write };
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
      const { controller } = buildController(() =>
        Promise.reject(new WalletAlreadyExistsError('player-1', 'USD')),
      );

      const error = await captureAsyncError(() =>
        controller.create({ playerId: 'player-1', currency: 'USD' }),
      );

      expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    });
  });
});
