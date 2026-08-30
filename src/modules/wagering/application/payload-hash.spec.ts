import { describe, expect, it } from 'bun:test';
import { hashPayload, type SubmitBetPayload } from './payload-hash';

function buildPayload(overrides?: Partial<SubmitBetPayload>): SubmitBetPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    amount: '25.00',
    currency: 'BRL',
    ...overrides,
  };
}

describe('hashPayload', () => {
  it('produces the same hash regardless of key order', () => {
    const payload = buildPayload();
    const reordered: SubmitBetPayload = {
      currency: payload.currency,
      amount: payload.amount,
      kind: payload.kind,
      gameId: payload.gameId,
      roundId: payload.roundId,
      walletId: payload.walletId,
      playerId: payload.playerId,
      externalTransactionId: payload.externalTransactionId,
      providerId: payload.providerId,
    };

    expect(hashPayload(payload)).toBe(hashPayload(reordered));
  });

  it('produces the same hash for two structurally identical payload objects', () => {
    expect(hashPayload(buildPayload())).toBe(hashPayload(buildPayload()));
  });

  it.each([
    ['providerId', 'provider-b'],
    ['externalTransactionId', 'transaction-999'],
    ['playerId', 'player-2'],
    ['walletId', 'wallet-2'],
    ['roundId', 'round-000'],
    ['gameId', 'other-game'],
    ['kind', 'WIN'],
    ['amount', '25.01'],
    ['currency', 'USD'],
  ] as const)('produces a different hash when %s differs', (field, value) => {
    const base = buildPayload();
    const changed = buildPayload({ [field]: value } as Partial<SubmitBetPayload>);

    expect(hashPayload(changed)).not.toBe(hashPayload(base));
  });

  it('is a 64-character lowercase hex sha256 digest', () => {
    const hash = hashPayload(buildPayload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
