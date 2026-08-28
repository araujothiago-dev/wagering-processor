// Placeholder for the `shared/money` layer (Structural Seed, ARCHITECTURE.md).
//
// This will hold the decimal.js-backed `Money` value object used by the domain layer of both
// `wallet` and `wagering`. It is intentionally empty in Story 1.1 (scaffolding-only) — the
// real implementation, with its invariants (fixed 2-decimal scale, no NaN/Infinity/scientific
// notation, currency-mismatch guards), lands in Story 1.2.
//
// Rule (AD-2/AD-8): this file, and everything under shared/money, must never import NestJS,
// TypeORM, or any other infrastructure SDK — only `decimal.js`, a pure calculation library.
export {};
