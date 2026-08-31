// `wagering/application` — payload-hash (Story 2.1, widened Story 2.2, README §9
// "Idempotência").
//
// `payloadHash` = sha256 of a canonical JSON encoding (business keys, sorted) of the request's
// business fields — never the `Idempotency-Key` header, never the header's own value, never
// transport metadata. Two requests with the same business fields in a different key order must
// hash identically; any business field that differs must hash differently — that is exactly
// the replay-vs-conflict decision `SubmitWagerTransactionalWriterImpl` makes on an
// `idempotency_key` collision.
import { createHash } from 'node:crypto';

export interface SubmitWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  // Story 2.2 — a WIN's optional reference is a business field like any other: two requests
  // that only differ by this must never be treated as the same payload on an idempotency-key
  // replay. Omitted (never passed) by BET/LOSS, which never carry a reference.
  referenceExternalTransactionId?: string;
}

export function hashPayload(payload: SubmitWagerPayload): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex');
}

// Rebuilds the object with keys inserted in sorted order — `JSON.stringify` on a plain object
// serializes string-keyed properties in insertion order, so this is enough to make the output
// independent of the input object's own key order, with no dependency on a JSON library.
// `JSON.stringify` itself drops any key whose value is `undefined`, so an absent
// `referenceExternalTransactionId` never appears in the hashed string at all — it hashes
// identically to a payload that never declared the field.
function canonicalize(payload: SubmitWagerPayload): string {
  const sorted: Record<string, string | undefined> = {};

  for (const key of Object.keys(payload).sort()) {
    sorted[key] = payload[key as keyof SubmitWagerPayload];
  }

  return JSON.stringify(sorted);
}
