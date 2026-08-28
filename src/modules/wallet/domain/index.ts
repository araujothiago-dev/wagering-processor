// Placeholder for `modules/wallet/domain` (Structural Seed, ARCHITECTURE.md).
//
// Will hold `Wallet` (aggregate root), `WalletLedgerEntry`, and wallet-specific domain errors.
// Introduced in Story 1.2 ("Criar Wallet com Saldo Inicial").
//
// Rule (AD-1/AD-2): this layer never imports NestJS, TypeORM, HTTP, or SQS — every balance
// transition happens inside these classes (private constructor + static factories: `open`,
// `rehydrate`), never in a use case or a repository.
export {};
