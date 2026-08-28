// Placeholder for the `shared/http` layer (Structural Seed, ARCHITECTURE.md).
//
// Will hold the central `ExceptionFilter` that maps typed domain errors to the
// `{ error: { code, message, details? } }` envelope and the failureCode -> HTTP status mapping
// (AD-7). Not needed yet: Story 1.1 exposes only the public, unauthenticated health endpoints,
// which never go through the domain error envelope. Introduced in Story 1.2.
export {};
