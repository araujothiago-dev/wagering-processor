// `wagering/application` — payload-hash (Story 2.1, README §9 "Idempotência").
//
// `payloadHash` = sha256 of a canonical JSON encoding (business keys, sorted) of the request's
// business fields — never the `Idempotency-Key` header, never the header's own value, never
// transport metadata. Two requests with the same business fields in a different key order must
// hash identically; any business field that differs must hash differently — that is exactly
// the replay-vs-conflict decision `SubmitBetTransactionalWriterImpl` makes on an
// `idempotency_key` collision.
import { createHash } from 'node:crypto';

export interface SubmitBetPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
}

export function hashPayload(payload: SubmitBetPayload): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

// Rebuilds the object with keys inserted in sorted order — `JSON.stringify` on a plain object
// serializes string-keyed properties in insertion order, so this is enough to make the output
// independent of the input object's own key order, with no dependency on a JSON library.
function canonicalize(payload: SubmitBetPayload): string {
  const sorted: Record<string, string> = {};

  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key as keyof SubmitBetPayload];
  }

  return JSON.stringify(sorted);
}
