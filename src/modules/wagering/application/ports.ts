// `wagering/application` ports (Story 2.1, widened Story 2.2). Pure interfaces — no NestJS/
// TypeORM import (AD-2); `infrastructure` provides the concrete adapter
// (`SubmitWagerTransactionalWriterImpl`).
//
// Named generically since Story 2.1 (`SubmitBet*`): the lock+savepoint+idempotency mechanics
// this port describes are the same for every synchronous wager kind (BET, WIN, LOSS today;
// REFUND/ROLLBACK in Story 2.3) — only what `decide` computes differs per kind, never how the
// writer persists it.
import type { Money } from '../../../shared/money';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from '../domain/wager-transaction';

// Returned by the `decide` callback the use case hands the writer. `wallet`/`ledgerEntry` are
// present only when `transaction.status === 'PROCESSED'` **and** the kind affects the balance
// (`WagerTransaction.affectsBalance()`) — a `REJECTED` decision (insufficient balance) or a
// `LOSS` (no balance effect by rule) carries only the transaction itself, nothing to apply
// against the wallet or ledger.
export interface SubmitWagerDecision {
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
export type SubmitWagerDecide = (lockedWallet: Wallet) => SubmitWagerDecision;

export interface SubmitWagerOutcome {
  transaction: WagerTransaction;
  // Present whenever `transaction.status === 'PROCESSED'` — for a balance-affecting kind, the
  // frozen `balanceAfter` of the one `WalletLedgerEntry` produced (the wallet's *current*
  // balance is never read for a replay: spec "saldo retornado é o balanceAfter congelado da
  // transação original"); for `LOSS`, the wallet's unchanged balance at lock time (fresh or
  // replayed — there is no ledger entry to freeze one from, but the value is the same either way
  // since nothing ever moved it).
  balanceAfter?: Money;
  idempotentReplay: boolean;
}

// Story 2.4 — read-only, no lock: querying a transaction never touches balance/ledger.
export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
}

export interface SubmitWagerTransactionalWriter {
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
  submit(walletId: string, decide: SubmitWagerDecide): Promise<SubmitWagerOutcome>;
}
