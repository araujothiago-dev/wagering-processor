// `wagering/application` — SubmitWinLossUseCase (Story 2.2).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter. Shares
// `SubmitWagerTransactionalWriter` with `SubmitBetUseCase` (Story 2.1) — same lock+savepoint+
// idempotency mechanics, only what `decide` computes differs.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { ReferenceScopeMismatchError } from '../domain/errors';
import { WagerTransaction } from '../domain/wager-transaction';
import { hashPayload } from './payload-hash';
import type { SubmitWagerDecide, SubmitWagerTransactionalWriter, WagerTransactionRepository } from './ports';

export type SubmitWinLossKind = 'WIN' | 'LOSS';

export interface SubmitWinLossCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmitWinLossKind;
  amount: string;
  currency: string;
  idempotencyKey: string;
  // WIN-only, optional (README §7: "pode referenciar a BET da mesma rodada"). Never read for
  // LOSS — a LOSS never references anything, so a value here is simply ignored for that kind
  // (documented interpretation: epics.md doesn't define LOSS+reference behavior at all).
  referenceExternalTransactionId?: string;
}

export interface SubmitWinLossResult {
  transactionId: string;
  status: 'PROCESSED';
  balance: Money;
  currency: string;
  idempotentReplay: boolean;
}

export class SubmitWinLossUseCase {
  constructor(
    private readonly writer: SubmitWagerTransactionalWriter,
    private readonly wagerTransactionRepository: WagerTransactionRepository,
  ) {}

  async execute(command: SubmitWinLossCommand): Promise<SubmitWinLossResult> {
    // Parsed/resolved once, outside the locked transaction: a malformed amount/currency still
    // fails fast without ever attempting the wallet lock. An unresolvable reference does NOT —
    // it flows into `decide` below and becomes a committed REJECTED row, same pattern as BET's
    // INSUFFICIENT_BALANCE (Story 2.1: "rejeição comitada, erro HTTP retornado"). This matters
    // for idempotency: without a persisted row, a repeated WIN with a bad reference would re-hit
    // the repository lookup on every retry instead of replaying a stored decision.
    const money = Money.of(command.amount, command.currency);
    const referenceResolution = await this.resolveReference(command);

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

    const decide: SubmitWagerDecide = (lockedWallet) => {
      if (command.kind === 'LOSS') {
        // No balance effect (README §7) — no ledgerEntry, no wallet mutation. Currency is still
        // checked first, same as every other kind (FR20): `Money.of` above only validates shape,
        // never that it matches the wallet's own currency — `applyDebit`/`applyCredit` do that for
        // BET/WIN via `assertSameCurrency`, and LOSS never calls either, so it must assert
        // explicitly here or a currency-mismatched LOSS would silently process as PROCESSED.
        lockedWallet.assertSameCurrency(money);

        return {
          transaction: WagerTransaction.processed({
            id: transactionId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            playerId: command.playerId,
            walletId: command.walletId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: 'LOSS',
            money,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
          }),
        };
      }

      if (referenceResolution.kind === 'INVALID') {
        // Committed, audited REJECTED row — never touches the wallet/ledger. Re-thrown as
        // ReferenceScopeMismatchError after the writer commits (see below), same shape as
        // INSUFFICIENT_BALANCE.
        return {
          transaction: WagerTransaction.rejected({
            id: transactionId,
            providerId: command.providerId,
            externalTransactionId: command.externalTransactionId,
            playerId: command.playerId,
            walletId: command.walletId,
            roundId: command.roundId,
            gameId: command.gameId,
            kind: 'WIN',
            money,
            idempotencyKey: command.idempotencyKey,
            payloadHash,
            failureCode: 'REFERENCE_SCOPE_MISMATCH',
            referenceTransactionId: referenceResolution.foundReferenceTransactionId,
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
          kind: 'WIN',
          money,
          idempotencyKey: command.idempotencyKey,
          payloadHash,
          referenceTransactionId: referenceResolution.kind === 'VALID' ? referenceResolution.referenceTransactionId : undefined,
        }),
        wallet: creditedWallet,
        ledgerEntry,
      };
    };

    const outcome = await this.writer.submit(command.walletId, decide);

    if (outcome.transaction.status === 'REJECTED') {
      // Committed but still an error from the caller's point of view — same pattern as BET's
      // INSUFFICIENT_BALANCE (Story 2.1): re-thrown after commit so the controller maps it to
      // 422 REFERENCE_SCOPE_MISMATCH. True for both a fresh rejection and a replayed one.
      throw new ReferenceScopeMismatchError(command.referenceExternalTransactionId ?? '');
    }

    if (outcome.transaction.status !== 'PROCESSED') {
      // LOSS never rejects (no sufficiency check) and neither kind produces PENDING_REFERENCE/
      // FAILED yet (Epic 2.3/3) — fail loudly instead of silently mishandling an unexpected
      // status once those become real.
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

  // One error code (`REFERENCE_SCOPE_MISMATCH`) covers "not found", "wrong kind", and "wrong
  // scope" for this story — see the comment on `ReferenceScopeMismatchError` for why Story 2.2
  // doesn't split those further. Resolved as data, never thrown here — `decide` (inside the
  // wallet lock) is what turns an INVALID resolution into a committed REJECTED row.
  private async resolveReference(command: SubmitWinLossCommand): Promise<ReferenceResolution> {
    if (command.kind !== 'WIN' || command.referenceExternalTransactionId === undefined) {
      return { kind: 'NONE' };
    }

    const referenceExternalTransactionId = command.referenceExternalTransactionId;
    const referenced = await this.wagerTransactionRepository.findByProviderAndExternalId(
      command.providerId,
      referenceExternalTransactionId,
    );

    if (referenced === null) {
      return { kind: 'INVALID' };
    }

    const inScope =
      referenced.kind === 'BET' &&
      referenced.status === 'PROCESSED' &&
      referenced.playerId === command.playerId &&
      referenced.walletId === command.walletId &&
      referenced.roundId === command.roundId &&
      referenced.money.currency === command.currency;

    return inScope
      ? { kind: 'VALID', referenceTransactionId: referenced.id }
      : { kind: 'INVALID', foundReferenceTransactionId: referenced.id };
  }
}

// Result of resolving WIN's optional reference (README §7), computed once in `execute()` — a
// repository read — *before* the wallet lock, then captured by the `decide` closure. `decide`
// itself stays a pure, synchronous callback with no SQL inside it (ports.ts's contract) — an
// async repository call cannot happen inside it. `NONE` (LOSS, or WIN without a reference) never
// reaches the branch that reads this; `INVALID` carries the found-but-out-of-scope row's id when
// there was one, `undefined` when nothing resolved at all (kept only for the audit trail — both
// cases still map to the single REFERENCE_SCOPE_MISMATCH code).
type ReferenceResolution =
  | { kind: 'NONE' }
  | { kind: 'VALID'; referenceTransactionId: string }
  | { kind: 'INVALID'; foundReferenceTransactionId?: string };
