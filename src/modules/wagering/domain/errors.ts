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

// Story 2.2 — thrown when a WIN's optional `referenceExternalTransactionId` doesn't resolve to
// a BET belonging to the same provider/player/wallet/currency/round (README §7 rule 2), or
// resolves to something that isn't a PROCESSED BET at all. One code covers "not found", "wrong
// kind", and "wrong scope" for this story — Story 2.3 (REFUND/ROLLBACK) is the one that splits
// those into distinct codes (`REFERENCE_WRONG_KIND` vs `REFERENCE_SCOPE_MISMATCH`), since only
// there does the epics spec require telling them apart.
export class ReferenceScopeMismatchError extends Error {
  readonly code = 'REFERENCE_SCOPE_MISMATCH' as const;

  constructor(referenceExternalTransactionId: string) {
    super(
      `Reference '${referenceExternalTransactionId}' does not resolve to a PROCESSED BET in the ` +
        'same provider/player/wallet/currency/round.',
    );
    this.name = 'ReferenceScopeMismatchError';
  }
}

// Story 2.4 — thrown for both query paths (`GET /wagering/transactions/:id` and
// `GET /providers/:providerId/wagering/transactions/:externalId`) when no row matches.
export class TransactionNotFoundError extends Error {
  readonly code = 'TRANSACTION_NOT_FOUND' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TransactionNotFoundError';
  }
}
