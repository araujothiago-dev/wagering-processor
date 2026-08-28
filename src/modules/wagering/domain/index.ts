// Placeholder for `modules/wagering/domain` (Structural Seed, ARCHITECTURE.md).
//
// Will hold `WagerTransaction`, `InboxMessage`, `OutboxMessage`, and wagering-specific domain
// errors. Introduced starting Epic 2 ("Submeter Bet" onward).
//
// Rule (AD-1/AD-2): this layer never imports NestJS, TypeORM, HTTP, or SQS — every state
// transition (`markProcessed`, `markPendingReference`, `reject`, `fail`) happens inside these
// classes, never in a use case or a controller.
export {};
