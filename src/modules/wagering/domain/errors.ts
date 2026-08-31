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

// Story 2.4 — thrown for both query paths (`GET /wagering/transactions/:id` and
// `GET /providers/:providerId/wagering/transactions/:externalId`) when no row matches.
export class TransactionNotFoundError extends Error {
  readonly code = 'TRANSACTION_NOT_FOUND' as const;

  constructor(message: string) {
    super(message);
    this.name = 'TransactionNotFoundError';
  }
}

// Story 2.2 — thrown when a `WIN`'s optional `referenceExternalTransactionId` resolves to a row
// that exists but is out of scope: not a `BET`, not `PROCESSED`, or a different player/wallet/
// round/currency than this `WIN` (AD-7 — distinct cause, distinct failureCode, never shares a
// code with `REFERENCE_NOT_FOUND`). Persisted as a committed `REJECTED` wager_transaction, same
// pattern as `InsufficientBalanceError` — an audited business rejection, not an aborted request.
export class ReferenceScopeMismatchError extends Error {
  readonly code = 'REFERENCE_SCOPE_MISMATCH' as const;

  constructor(referenceExternalTransactionId: string) {
    super(
      `Reference transaction '${referenceExternalTransactionId}' does not match the scope ` +
        `(provider/player/wallet/currency/round) of this transaction.`,
    );
    this.name = 'ReferenceScopeMismatchError';
  }
}

// Story 2.2 — thrown when a `WIN`'s optional `referenceExternalTransactionId` was never submitted
// to the system at all. Spec Design Notes: this is treated as an inconsistent/invalid payload
// (rejection, `422`), never `PENDING_REFERENCE` (`202`) — `PENDING_REFERENCE`/AD-6 is reserved for
// `REFUND`/`ROLLBACK` (Story 2.3/3.3), where the reference is mandatory. Persisted as a committed
// `REJECTED` wager_transaction, same pattern as `InsufficientBalanceError`.
export class ReferenceNotFoundError extends Error {
  readonly code = 'REFERENCE_NOT_FOUND' as const;

  constructor(providerId: string, referenceExternalTransactionId: string) {
    super(
      `No transaction found for provider '${providerId}' and externalTransactionId ` +
        `'${referenceExternalTransactionId}'.`,
    );
    this.name = 'ReferenceNotFoundError';
  }
}
