// Placeholder for `modules/wallet/infrastructure` (Structural Seed, ARCHITECTURE.md).
//
// Will hold the TypeORM adapters that implement the ports declared in `application`
// (`WalletTypeOrmRepository`, `LedgerTypeOrmRepository`). Introduced starting Story 1.2.
//
// Rule (AD-2/AD-3): financial writes always go through an explicit `QueryRunner` (never an
// implicit `Repository.save()`), and this layer implements ports — it never gets called
// directly from `interface`.
export {};
