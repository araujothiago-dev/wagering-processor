import { describe, expect, it, mock } from 'bun:test';
import { MoneyValidationError } from '../../../shared/money';
import { WalletAlreadyExistsError } from '../domain/errors';
import { CreateWalletUseCase } from './create-wallet.use-case';
import type { CreateWalletTransactionalWriter, CreateWalletWriteCommand } from './ports';

function buildWriter(impl?: (command: CreateWalletWriteCommand) => Promise<void>) {
  const write = mock(impl ?? (() => Promise.resolve()));
  const writer: CreateWalletTransactionalWriter = { write };
  return { writer, write };
}

describe('CreateWalletUseCase', () => {
  describe('happy path — without initial balance', () => {
    it('opens the wallet with a "0.00" balance and writes it with no opening bundle', async () => {
      const { writer, write } = buildWriter();
      const useCase = new CreateWalletUseCase(writer);

      const wallet = await useCase.execute({ playerId: 'player-1', currency: 'USD' });

      expect(wallet.balance.amount).toBe('0.00');
      expect(wallet.version).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);

      const command = write.mock.calls[0]?.[0] as CreateWalletWriteCommand;
      expect(command.wallet).toBe(wallet);
      expect(command.opening).toBeUndefined();
    });
  });

  describe('happy path — with initial balance', () => {
    it('opens the wallet with the given balance and writes an OPENING bundle', async () => {
      const { writer, write } = buildWriter();
      const useCase = new CreateWalletUseCase(writer);

      const wallet = await useCase.execute({
        playerId: 'player-1',
        currency: 'USD',
        initialBalance: '50.00',
      });

      expect(wallet.balance.amount).toBe('50.00');
      expect(wallet.version).toBe(1);
      expect(write).toHaveBeenCalledTimes(1);

      const command = write.mock.calls[0]?.[0] as CreateWalletWriteCommand;
      expect(command.wallet).toBe(wallet);

      const opening = command.opening;
      if (!opening) {
        throw new Error('expected an opening bundle to be built');
      }

      expect(opening.ledgerEntry.direction).toBe('CREDIT');
      expect(opening.ledgerEntry.walletId).toBe(wallet.id);
      expect(opening.ledgerEntry.wagerTransactionId).toBe(opening.wagerTransactionId);
      expect(opening.ledgerEntry.balanceBefore.amount).toBe('0.00');
      expect(opening.ledgerEntry.balanceAfter.amount).toBe('50.00');

      expect(opening.outboxMessage).toEqual({
        type: 'WalletBalanceChanged',
        walletId: wallet.id,
        playerId: 'player-1',
        currency: 'USD',
        balanceBefore: '0.00',
        balanceAfter: '50.00',
        wagerTransactionId: opening.wagerTransactionId,
        occurredAt: opening.outboxMessage.occurredAt,
      });
      expect(() => new Date(opening.outboxMessage.occurredAt).toISOString()).not.toThrow();
    });
  });

  describe('duplicate wallet', () => {
    it('propagates WalletAlreadyExistsError from the writer without altering it', async () => {
      const { writer } = buildWriter(() =>
        Promise.reject(new WalletAlreadyExistsError('player-1', 'USD')),
      );
      const useCase = new CreateWalletUseCase(writer);

      await expect(
        useCase.execute({ playerId: 'player-1', currency: 'USD' }),
      ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    });
  });

  describe('validation errors', () => {
    it('propagates a Money validation error and never calls the writer', async () => {
      const { writer, write } = buildWriter();
      const useCase = new CreateWalletUseCase(writer);

      await expect(
        useCase.execute({ playerId: 'player-1', currency: 'USD', initialBalance: '-1.00' }),
      ).rejects.toBeInstanceOf(MoneyValidationError);

      expect(write).not.toHaveBeenCalled();
    });
  });
});
