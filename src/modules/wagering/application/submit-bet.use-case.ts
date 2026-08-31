// `wagering/application` — SubmitBetUseCase (Story 2.1; generalized to WIN/LOSS in Story 2.2).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';
import { InsufficientBalanceError } from '../../wallet/domain/errors';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { ReferenceNotFoundError, ReferenceScopeMismatchError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { hashPayload } from './payload-hash';
import type { SubmitBetDecide, SubmitBetTransactionalWriter, WagerTransactionRepository } from './ports';

export type SubmitBetKind = 'BET' | 'WIN' | 'LOSS';

export interface SubmitBetCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmitBetKind;
  amount: string;
  currency: string;
  idempotencyKey: string;
  // Story 2.2 — WIN-only, optional: when present, must resolve to the `BET PROCESSED` of the
  // same provider/player/wallet/round/currency. `BET`/`LOSS` never read this.
  referenceExternalTransactionId?: string;
}

export interface SubmitBetResult {
  transactionId: string;
  status: 'PROCESSED';
  balance: Money;
  currency: string;
  idempotentReplay: boolean;
}

// Story 2.2 — outcome of resolving WIN's optional reference, computed once in `execute()` (a
// repository read) *before* `decide` runs, then captured by the `decide` closure below. `decide`
// itself stays a pure, synchronous callback with no SQL inside it (ports.ts's contract, unchanged
// by this story) — an async repository call cannot happen inside it. Neither NOT_FOUND nor
// SCOPE_MISMATCH depends on the locked wallet's mutable state (balance/version), only on the
// command's own fields versus the already-immutable resolved row, so resolving before the wallet
// lock loses nothing.
type ReferenceResolution =
  | { kind: 'NONE' }
  | { kind: 'FOUND'; reference: WagerTransaction }
  | { kind: 'NOT_FOUND' }
  | { kind: 'SCOPE_MISMATCH'; reference: WagerTransaction };

export class SubmitBetUseCase {
  constructor(
    private readonly writer: SubmitBetTransactionalWriter,
    private readonly transactionRepository: WagerTransactionRepository,
  ) {}

  async execute(command: SubmitBetCommand): Promise<SubmitBetResult> {
    // Parsed once, outside the locked transaction: a malformed amount/currency fails fast
    // (`MoneyValidationError`) without ever attempting the wallet lock — "nada processado".
    const money = Money.of(command.amount, command.currency);
    const payloadHash = hashPayload({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      amount: money.amount,
      currency: money.currency,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });
    const transactionId = randomUUID();
    const referenceResolution = await this.resolveReference(command);

    const decide: SubmitBetDecide = (lockedWallet) => {
      if (command.kind === 'LOSS') {
        // FR20 — a LOSS in a currency different from the wallet's is still rejected, same as
        // BET/WIN (which get this for free via `applyDebit`/`applyCredit`'s own
        // `assertSameCurrency` call). LOSS never calls either, so it must assert explicitly.
        // Thrown synchronously out of `decide`, aborting the whole SQL transaction untouched —
        // never a committed REJECTED row, exactly like BET/WIN's currency-mismatch path.
        lockedWallet.assertSameCurrency(money);

        // LOSS never touches wallet/ledger (spec "Never"): no WalletLedgerEntry, no
        // WalletBalanceChanged. `applyDecision` (writer) skips both when the decision carries no
        // `wallet`/`ledgerEntry`.
        return {
          transaction: WagerTransaction.processed({
            id: transactionId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            playerId: command.playerId,
            walletId: command.walletId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: command.kind,
            money,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
          }),
        };
      }

      if (command.kind === 'WIN') {
        if (referenceResolution.kind === 'NOT_FOUND') {
          // Design Notes: a reference the provider claims but that was never submitted is treated
          // as an inconsistent payload — a committed, audited REJECTED row (same pattern as
          // INSUFFICIENT_BALANCE below), not an aborted transaction.
          return {
            transaction: WagerTransaction.rejected({
              id: transactionId,
              providerId: command.providerId,
              externalTransactionId: command.externalTransactionId,
              playerId: command.playerId,
              walletId: command.walletId,
              roundId: command.roundId,
              gameId: command.gameId,
              kind: command.kind,
              money,
              idempotencyKey: command.idempotencyKey,
              payloadHash,
              failureCode: 'REFERENCE_NOT_FOUND',
            }),
          };
        }

        if (referenceResolution.kind === 'SCOPE_MISMATCH') {
          return {
            transaction: WagerTransaction.rejected({
              id: transactionId,
              providerId: command.providerId,
              externalTransactionId: command.externalTransactionId,
              playerId: command.playerId,
              walletId: command.walletId,
              roundId: command.roundId,
              gameId: command.gameId,
              kind: command.kind,
              money,
              idempotencyKey: command.idempotencyKey,
              payloadHash,
              failureCode: 'REFERENCE_SCOPE_MISMATCH',
              referenceTransactionId: referenceResolution.reference.id,
            }),
          };
        }

        const creditedWallet = lockedWallet.applyCredit(money);
        const ledgerEntry = WalletLedgerEntry.credit({
          walletId: lockedWallet.id,
          wagerTransactionId: transactionId,
          money,
          balanceBefore: lockedWallet.balance,
          balanceAfter: creditedWallet.balance,
        });

        return {
          transaction: WagerTransaction.processed({
            id: transactionId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            playerId: command.playerId,
            walletId: command.walletId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: command.kind,
            money,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
            referenceTransactionId: referenceResolution.kind === 'FOUND' ? referenceResolution.reference.id : undefined,
          }),
          wallet: creditedWallet,
          ledgerEntry,
        };
      }

      // BET (Story 2.1, unchanged).
      try {
        const debitedWallet = lockedWallet.applyDebit(money);
        const ledgerEntry = WalletLedgerEntry.debit({
          walletId: lockedWallet.id,
          wagerTransactionId: transactionId,
          money,
          balanceBefore: lockedWallet.balance,
          balanceAfter: debitedWallet.balance,
        });

        return {
          transaction: WagerTransaction.processed({
            id: transactionId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            playerId: command.playerId,
            walletId: command.walletId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: command.kind,
            money,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
          }),
          wallet: debitedWallet,
          ledgerEntry,
        };
      } catch (error) {
        // Only insufficient balance is a *business* rejection — persisted and committed
        // (spec "Rejeição comitada, erro HTTP retornado"). Any other error (e.g. a currency
        // mismatch, which `applyDebit` also throws) must propagate out of `decide` untouched so
        // the writer aborts the whole SQL transaction instead of persisting anything.
        if (!(error instanceof InsufficientBalanceError)) {
          throw error;
        }

        return {
          transaction: WagerTransaction.rejected({
            id: transactionId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            playerId: command.playerId,
            walletId: command.walletId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: command.kind,
            money,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
            failureCode: error.code,
          }),
        };
      }
    };

    const outcome = await this.writer.submit(command.walletId, decide);

    if (outcome.transaction.status === 'REJECTED') {
      // Committed but still an error from the caller's point of view — re-thrown after commit so
      // the controller maps it to the right 422 (this reconstructs the specific error type from
      // the persisted `failureCode`; neither a fresh nor a replayed rejection re-evaluates
      // anything, both surface the same terminal error).
      if (outcome.transaction.failureCode === 'REFERENCE_NOT_FOUND') {
        throw new ReferenceNotFoundError(command.providerId, command.referenceExternalTransactionId ?? '');
      }

      if (outcome.transaction.failureCode === 'REFERENCE_SCOPE_MISMATCH') {
        throw new ReferenceScopeMismatchError(command.referenceExternalTransactionId ?? '');
      }

      throw new InsufficientBalanceError(command.walletId, money);
    }

    if (outcome.transaction.status !== 'PROCESSED') {
      // This story only ever produces PROCESSED/REJECTED — PENDING_REFERENCE/FAILED aren't
      // reachable yet (Epic 2.3/3). Fail loudly instead of silently mapping an unexpected status
      // to INSUFFICIENT_BALANCE once those become real.
      throw new Error(`Unexpected non-terminal status '${outcome.transaction.status}'.`);
    }

    if (!outcome.balanceAfter) {
      throw new Error('Invariant violation: a PROCESSED outcome must carry balanceAfter.');
    }

    return {
      transactionId: outcome.transaction.id,
      status: 'PROCESSED',
      balance: outcome.balanceAfter,
      currency: command.currency,
      idempotentReplay: outcome.idempotentReplay,
    };
  }

  private async resolveReference(command: SubmitBetCommand): Promise<ReferenceResolution> {
    if (command.kind !== 'WIN' || !command.referenceExternalTransactionId) {
      return { kind: 'NONE' };
    }

    const reference = await this.transactionRepository.findByProviderAndExternalId(
      command.providerId,
      command.referenceExternalTransactionId,
    );

    if (!reference) {
      return { kind: 'NOT_FOUND' };
    }

    const inScope =
      reference.kind === 'BET' &&
      reference.status === 'PROCESSED' &&
      reference.playerId === command.playerId &&
      reference.walletId === command.walletId &&
      reference.roundId === command.roundId &&
      reference.money.currency === command.currency;

    return inScope ? { kind: 'FOUND', reference } : { kind: 'SCOPE_MISMATCH', reference };
  }
}
