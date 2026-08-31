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

  // Story 2.2 — WIN's optional reference is a business field: it must participate in the
  // payload-hash so a WIN resubmitted with the same Idempotency-Key but a different
  // `referenceExternalTransactionId` is detected as IDEMPOTENCY_KEY_CONFLICT, not a replay.
  describe('referenceExternalTransactionId', () => {
    it('produces the same hash whether the field is omitted or explicitly undefined', () => {
      const omitted = buildPayload();
      const explicitUndefined = buildPayload({ referenceExternalTransactionId: undefined });

      expect(hashPayload(omitted)).toBe(hashPayload(explicitUndefined));
    });

    it('produces a different hash when present vs. absent', () => {
      const withoutRef = buildPayload();
      const withRef = buildPayload({ referenceExternalTransactionId: 'bet-external-id' });

      expect(hashPayload(withRef)).not.toBe(hashPayload(withoutRef));
    });

    it('produces a different hash when the referenced id differs', () => {
      const first = buildPayload({ referenceExternalTransactionId: 'bet-external-id-1' });
      const second = buildPayload({ referenceExternalTransactionId: 'bet-external-id-2' });

      expect(hashPayload(first)).not.toBe(hashPayload(second));
    });
  });
});
