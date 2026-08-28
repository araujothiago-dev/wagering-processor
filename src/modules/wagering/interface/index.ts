// Placeholder for `modules/wagering/interface` (Structural Seed, ARCHITECTURE.md).
//
// Will hold `WageringController` (POST /wagering/transactions and read endpoints) and
// `WagerTransactionsSqsConsumer` (AD-13: business/transient/permanent error classification,
// DLQ routing, graceful SIGTERM drain). Introduced starting Epic 2 (controller) and Epic 3
// (SQS consumer).
//
// Rule (AD-2): this layer calls only `application` use cases — the controller and the SQS
// consumer both invoke the same use case, never a repository directly.
export {};
