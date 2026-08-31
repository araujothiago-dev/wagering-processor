// `wagering/application` — SubmitBetUseCase (Story 2.1).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter.
import { randomUUID } from 'node:crypto';
import { Money } from '../../../shared/money';
import { InsufficientBalanceError } from '../../wallet/domain/errors';
import { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wager-transaction';
import { hashPayload } from './payload-hash';
import type { SubmitWagerDecide, SubmitWagerTransactionalWriter } from './ports';

const KIND = 'BET' as const;

export interface SubmitBetCommand {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
}

export interface SubmitBetResult {
  transactionId: string;
  status: 'PROCESSED';
  balance: Money;
  currency: string;
  idempotentReplay: boolean;
}

export class SubmitBetUseCase {
  constructor(private readonly writer: SubmitWagerTransactionalWriter) {}

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
      kind: KIND,
      amount: money.amount,
      currency: money.currency,
    });
    const transactionId = randomUUID();

    const decide: SubmitWagerDecide = (lockedWallet) => {
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
            kind: KIND,
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
            kind: KIND,
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
      // Committed but still an error from the caller's point of view — re-thrown after commit
      // so the controller maps it to `422 INSUFFICIENT_BALANCE` (this story's only REJECTED
      // failure code). True for both a fresh rejection and a replayed one: neither re-evaluates
      // the current balance, both surface the same terminal error.
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
}
