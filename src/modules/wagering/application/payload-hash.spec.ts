import { describe, expect, it } from 'bun:test';
import { hashPayload, type SubmitWagerPayload } from './payload-hash';

function buildPayload(overrides?: Partial<SubmitWagerPayload>): SubmitWagerPayload {
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
    const reordered: SubmitWagerPayload = {
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
    const changed = buildPayload({ [field]: value } as Partial<SubmitWagerPayload>);

    expect(hashPayload(changed)).not.toBe(hashPayload(base));
  });

  it('is a 64-character lowercase hex sha256 digest', () => {
    const hash = hashPayload(buildPayload());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('referenceExternalTransactionId (Story 2.2)', () => {
    it('hashes identically whether the field is omitted or explicitly undefined', () => {
      const omitted = hashPayload(buildPayload());
      const explicit = hashPayload({ ...buildPayload(), referenceExternalTransactionId: undefined });

      expect(explicit).toBe(omitted);
    });

    it('produces a different hash when a reference is present vs. absent', () => {
      const withoutReference = hashPayload(buildPayload());
      const withReference = hashPayload({ ...buildPayload(), referenceExternalTransactionId: 'ext-bet-1' });

      expect(withReference).not.toBe(withoutReference);
    });

    it('produces a different hash when the reference itself differs', () => {
      const first = hashPayload({ ...buildPayload(), referenceExternalTransactionId: 'ext-bet-1' });
      const second = hashPayload({ ...buildPayload(), referenceExternalTransactionId: 'ext-bet-2' });

      expect(first).not.toBe(second);
    });
  });
});
