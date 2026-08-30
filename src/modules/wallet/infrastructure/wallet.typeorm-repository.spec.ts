import { describe, expect, it, mock } from 'bun:test';
import type { Repository } from 'typeorm';
import { WalletTypeOrmRepository } from './wallet.typeorm-repository';
import type { WalletEntity } from './wallet.entity';

function buildRepository(findOneByImpl?: (...args: unknown[]) => Promise<WalletEntity | null>) {
  const findOneBy = mock(findOneByImpl ?? (() => Promise.resolve(null)));
  const repository = { findOneBy } as unknown as Repository<WalletEntity>;
  return { repository, findOneBy };
}

describe('WalletTypeOrmRepository', () => {
  describe('found', () => {
    it('maps the row into a rehydrated Wallet', async () => {
      const row: WalletEntity = {
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'USD',
        balanceAmount: '50.00',
        version: 3,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      const { repository, findOneBy } = buildRepository(() => Promise.resolve(row));
      const adapter = new WalletTypeOrmRepository(repository);

      const wallet = await adapter.findById('wallet-1');

      expect(findOneBy).toHaveBeenCalledWith({ id: 'wallet-1' });
      expect(wallet).not.toBeNull();
      expect(wallet?.id).toBe('wallet-1');
      expect(wallet?.playerId).toBe('player-1');
      expect(wallet?.currency).toBe('USD');
      expect(wallet?.balance.amount).toBe('50.00');
      expect(wallet?.version).toBe(3);
    });
  });

  describe('not found', () => {
    it('returns null when no row matches', async () => {
      const { repository } = buildRepository(() => Promise.resolve(null));
      const adapter = new WalletTypeOrmRepository(repository);

      const wallet = await adapter.findById('missing-wallet');

      expect(wallet).toBeNull();
    });
  });
});
