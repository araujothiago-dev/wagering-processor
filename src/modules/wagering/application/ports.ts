// `wagering/application` ports (Story 2.1). Pure interfaces — no NestJS/TypeORM import (AD-2);
// `infrastructure` provides the concrete adapter (`SubmitBetTransactionalWriterImpl`).
import type { Money } from '../../../shared/money';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';

// Returned by the `decide` callback the use case hands the writer. `wallet`/`ledgerEntry` are
// present only when `transaction.status === 'PROCESSED'` — a `REJECTED` decision (insufficient
// balance) carries only the transaction itself, nothing to apply against the wallet or ledger.
export interface SubmitBetDecision {
  transaction: WagerTransaction;
  wallet?: Wallet;
  ledgerEntry?: WalletLedgerEntry;
}

// Pure domain decision, run with the wallet row already locked (`SELECT ... FOR UPDATE`) —
// no SQL happens inside this callback. Throwing out of it (e.g. `CurrencyMismatchError`) aborts
// the whole SQL transaction — nothing gets persisted, not even an audit row (spec matrix
// "Moeda incompatível ... nada processado"). Returning a decision, whether PROCESSED or
// REJECTED, means the transaction is commit-worthy: `INSUFFICIENT_BALANCE` still gets a
// persisted, auditable `REJECTED` row (spec "Rejeição comitada, erro HTTP retornado").
export type SubmitBetDecide = (lockedWallet: Wallet) => SubmitBetDecision;

export interface SubmitBetOutcome {
  transaction: WagerTransaction;
  // Present only when `transaction.status === 'PROCESSED'` — the frozen `balanceAfter` of the
  // one `WalletLedgerEntry` this BET produced (the wallet's *current* balance is never read for
  // a replay: spec "saldo retornado é o balanceAfter congelado da transação original").
  balanceAfter?: Money;
  idempotentReplay: boolean;
}

// Story 2.4 — read-only, no lock: querying a transaction never touches balance/ledger.
export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
}

export interface SubmitBetTransactionalWriter {
  /**
   * Locks the wallet row (`SELECT ... FOR UPDATE`, blocking, no `NOWAIT`/`SKIP LOCKED`),
   * invokes `decide` with the locked wallet, and persists the resulting decision as a
   * speculative `wager_transactions` insert guarded by a named `SAVEPOINT` (raw SQL, never
   * TypeORM's automatic nested-transaction savepoint).
   *
   * On a `UNIQUE(idempotency_key)` violation: rolls back to the savepoint (the wallet lock is
   * kept — the transaction is not aborted) and reads the existing row. Same `payloadHash` =>
   * replay, returning the existing row's terminal outcome (`decide`'s result for this call is
   * discarded, never persisted). Different `payloadHash` => throws
   * `IdempotencyKeyConflictError`.
   *
   * Throws `WalletNotFoundError` if `walletId` has no row — `decide` is never invoked in that
   * case.
   */
  submit(walletId: string, decide: SubmitBetDecide): Promise<SubmitBetOutcome>;
}
