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
    });

    it('carries an optional referenceTransactionId (Story 2.2 WIN referencing a BET)', () => {
      const transaction = WagerTransaction.processed({
        ...buildBaseProps(),
        kind: 'WIN',
        referenceTransactionId: 'tx-bet-original',
      });

      expect(transaction.referenceTransactionId).toBe('tx-bet-original');
    });

    it('leaves referenceTransactionId undefined when not given', () => {
      const transaction = WagerTransaction.processed(buildBaseProps());
      expect(transaction.referenceTransactionId).toBeUndefined();
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
    });

    it('carries an optional referenceTransactionId (Story 2.2 WIN with an out-of-scope reference)', () => {
      const transaction = WagerTransaction.rejected({
        ...buildBaseProps(),
        kind: 'WIN',
        failureCode: 'REFERENCE_SCOPE_MISMATCH',
        referenceTransactionId: 'tx-bet-out-of-scope',
      });

      expect(transaction.referenceTransactionId).toBe('tx-bet-out-of-scope');
    });

    it('leaves referenceTransactionId undefined when nothing resolved at all', () => {
      const transaction = WagerTransaction.rejected({
        ...buildBaseProps(),
        failureCode: 'INSUFFICIENT_BALANCE',
      });

      expect(transaction.referenceTransactionId).toBeUndefined();
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

  describe('affectsBalance', () => {
    it.each(['BET', 'WIN', 'REFUND', 'ROLLBACK'] as const)('is true for kind=%s', (kind) => {
      const transaction = WagerTransaction.processed({ ...buildBaseProps(), kind });
      expect(transaction.affectsBalance()).toBe(true);
    });

    it('is false for kind=LOSS', () => {
      const transaction = WagerTransaction.processed({ ...buildBaseProps(), kind: 'LOSS' });
      expect(transaction.affectsBalance()).toBe(false);
    });
  });
});
