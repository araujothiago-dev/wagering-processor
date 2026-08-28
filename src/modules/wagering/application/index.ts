// Placeholder for `modules/wagering/application` (Structural Seed, ARCHITECTURE.md).
//
// Will hold use cases (`SubmitWagerTransaction`, `ReprocessPendingReference`, `PublishOutbox`,
// ...) and the ports they depend on (`WagerTransactionRepository`, `EventPublisher`, ...).
// Introduced starting Epic 2.
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter. The same use case is reused by both
// the HTTP controller and the SQS consumer in `interface`.
export {};
