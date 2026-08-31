import { describe, expect, it } from 'bun:test';
import { Money } from '../../../shared/money';
import { WagerTransaction } from './wager-transaction';

function buildBaseProps() {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET' as const,
    money: Money.of('25.00', 'BRL'),
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'hash-1',
  };
}

describe('WagerTransaction', () => {
  describe('processed', () => {
    it('builds a terminal PROCESSED transaction with no failureCode', () => {
      const transaction = WagerTransaction.processed(buildBaseProps());

      expect(transaction.status).toBe('PROCESSED');
      expect(transaction.kind).toBe('BET');
      expect(transaction.money.amount).toBe('25.00');
      expect(transaction.idempotencyKey).toBe('provider-a:transaction-123');
      expect(transaction.payloadHash).toBe('hash-1');
      expect(transaction.failureCode).toBeUndefined();
      expect(transaction.referenceTransactionId).toBeUndefined();
    });

    // Story 2.2 — a WIN that resolved its optional reference to a BET.
    it('carries referenceTransactionId when provided', () => {
      const transaction = WagerTransaction.processed({
        ...buildBaseProps(),
        kind: 'WIN',
        referenceTransactionId: 'tx-bet-original',
      });

      expect(transaction.referenceTransactionId).toBe('tx-bet-original');
    });
  });

  describe('rejected', () => {
    it('builds a terminal REJECTED transaction carrying a failureCode', () => {
      const transaction = WagerTransaction.rejected({
        ...buildBaseProps(),
        failureCode: 'INSUFFICIENT_BALANCE',
      });

      expect(transaction.status).toBe('REJECTED');
      expect(transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
      expect(transaction.referenceTransactionId).toBeUndefined();
    });

    // Story 2.2 — a WIN rejected for REFERENCE_SCOPE_MISMATCH still records which row it resolved
    // to (out of scope, but found), for audit purposes; REFERENCE_NOT_FOUND never sets it.
    it('carries referenceTransactionId when the rejection was a scope mismatch on a resolved reference', () => {
      const transaction = WagerTransaction.rejected({
        ...buildBaseProps(),
        kind: 'WIN',
        failureCode: 'REFERENCE_SCOPE_MISMATCH',
        referenceTransactionId: 'tx-bet-out-of-scope',
      });

      expect(transaction.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
      expect(transaction.referenceTransactionId).toBe('tx-bet-out-of-scope');
    });
  });

  describe('rehydrate', () => {
    it('reconstructs a persisted PROCESSED row exactly, field for field', () => {
      const transaction = WagerTransaction.rehydrate({
        ...buildBaseProps(),
        status: 'PROCESSED',
      });

      expect(transaction.status).toBe('PROCESSED');
      expect(transaction.failureCode).toBeUndefined();
    });

    it('reconstructs a persisted REJECTED row with its failureCode', () => {
      const transaction = WagerTransaction.rehydrate({
        ...buildBaseProps(),
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_BALANCE',
      });

      expect(transaction.status).toBe('REJECTED');
      expect(transaction.failureCode).toBe('INSUFFICIENT_BALANCE');
    });
  });

  describe('matchesPayload', () => {
    it('is true when the payloadHash matches', () => {
      const transaction = WagerTransaction.processed(buildBaseProps());
      expect(transaction.matchesPayload('hash-1')).toBe(true);
    });

    it('is false when the payloadHash differs', () => {
      const transaction = WagerTransaction.processed(buildBaseProps());
      expect(transaction.matchesPayload('hash-2')).toBe(false);
    });
  });
});
