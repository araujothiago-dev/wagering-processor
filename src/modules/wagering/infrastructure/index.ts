// Placeholder for `modules/wagering/infrastructure` (Structural Seed, ARCHITECTURE.md).
//
// Will hold `WagerTransactionTypeOrmRepository`, `SqsPublisherAdapter`, and
// `SqsConsumerAdapter`. Introduced starting Epic 2 (repository) and Epic 3 (SQS adapters).
//
// Rule (AD-2/AD-3/AD-4): financial writes always go through an explicit `QueryRunner`, with
// the idempotency-key `SAVEPOINT` dance (AD-4) and the wallet-row `SELECT ... FOR UPDATE`
// (AD-3) living here, behind the ports declared in `application`.
export {};
