import { describe, expect, it } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor, LedgerCursorError } from './ledger-cursor.codec';

function captureError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('ledger-cursor codec', () => {
  describe('roundtrip', () => {
    it('decodes exactly what it encoded', () => {
      const cursor = { walletId: 'wallet-1', createdAt: '2026-01-01T00:00:00.000Z', id: 'entry-1' };

      const encoded = encodeLedgerCursor(cursor);
      const decoded = decodeLedgerCursor(encoded);

      expect(decoded).toEqual(cursor);
    });

    it('produces a URL-safe string (no "+", "/", or "=" padding)', () => {
      const encoded = encodeLedgerCursor({
        walletId: 'wallet-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'entry-1',
      });

      expect(encoded).not.toMatch(/[+/=]/);
    });
  });

  describe('malformed cursor', () => {
    it('rejects a literal non-decodable string', () => {
      const error = captureError(() => decodeLedgerCursor('lixo-nao-decodificavel'));

      expect(error).toBeInstanceOf(LedgerCursorError);
      expect((error as LedgerCursorError).code).toBe('VALIDATION_INVALID_CURSOR');
    });

    it('rejects valid base64url that decodes to non-JSON', () => {
      const notJson = Buffer.from('not json at all', 'utf8').toString('base64url');

      const error = captureError(() => decodeLedgerCursor(notJson));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });

    it('rejects valid JSON missing the "id" field', () => {
      const missingId = Buffer.from(
        JSON.stringify({ walletId: 'wallet-1', createdAt: '2026-01-01T00:00:00.000Z' }),
        'utf8',
      ).toString('base64url');

      const error = captureError(() => decodeLedgerCursor(missingId));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });

    it('rejects valid JSON missing the "createdAt" field', () => {
      const missingCreatedAt = Buffer.from(
        JSON.stringify({ walletId: 'wallet-1', id: 'entry-1' }),
        'utf8',
      ).toString('base64url');

      const error = captureError(() => decodeLedgerCursor(missingCreatedAt));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });

    it('rejects valid JSON missing the "walletId" field', () => {
      const missingWalletId = Buffer.from(
        JSON.stringify({ createdAt: '2026-01-01T00:00:00.000Z', id: 'entry-1' }),
        'utf8',
      ).toString('base64url');

      const error = captureError(() => decodeLedgerCursor(missingWalletId));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });

    it('rejects a JSON array instead of an object', () => {
      const arrayJson = Buffer.from(
        JSON.stringify(['wallet-1', '2026-01-01T00:00:00.000Z', 'entry-1']),
        'utf8',
      ).toString('base64url');

      const error = captureError(() => decodeLedgerCursor(arrayJson));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });

    it('rejects a createdAt that is not a valid timestamp', () => {
      const invalidTimestamp = Buffer.from(
        JSON.stringify({ walletId: 'wallet-1', createdAt: 'not-a-date', id: 'entry-1' }),
        'utf8',
      ).toString('base64url');

      const error = captureError(() => decodeLedgerCursor(invalidTimestamp));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });

    it('rejects an empty string', () => {
      const error = captureError(() => decodeLedgerCursor(''));

      expect(error).toBeInstanceOf(LedgerCursorError);
    });
  });
});
