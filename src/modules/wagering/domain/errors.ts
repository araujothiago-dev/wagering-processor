// `wagering/domain` errors (Story 2.1). Pure domain errors — no NestJS/HTTP mapping here
// (AD-1/AD-2); `shared/http` maps `code` to an HTTP status at the boundary.

// Thrown when a `wager_transactions.idempotency_key` collision is found on the speculative
// insert but the existing row's `payloadHash` differs from the incoming request's — never a
// replay in that case (README §6.3: "a mesma idempotency key com payload diferente é conflito,
// não replay").
export class IdempotencyKeyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT' as const;

  constructor(idempotencyKey: string) {
    super(`Idempotency-Key '${idempotencyKey}' was already used with a different payload.`);
    this.name = 'IdempotencyKeyConflictError';
  }
}
