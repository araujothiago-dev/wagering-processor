// `wagering/domain` — WagerTransaction aggregate (Story 2.1, ARCHITECTURE.md "Idempotência").
//
// Rule (AD-1/AD-2): this layer never imports NestJS, TypeORM, HTTP, or SQS.
//
// `WagerTransactionKind`/`WagerTransactionStatus` used to live in
// `wallet/infrastructure/wager-transaction.entity.ts` (Story 1.2, before this module had any
// domain code of its own) — they move here as the vocabulary's canonical home; the entity now
// imports them back from here (spec "Code Map").
//
// Unlike README §6.3's `WagerTransaction` (born `PENDING`, transitions via
// `markProcessed`/`reject`/`fail`), this aggregate follows the project's established pattern of
// immutable value objects with factories that return already-decided state (`Wallet.open`,
// `WalletLedgerEntry.credit`) — see spec "Design Notes" for why. `PENDING`/`PENDING_REFERENCE`
// are never produced by this story (every BET decision is synchronous, inside one SQL
// transaction); `processed`/`rejected` are the only two decided outcomes this story writes.
import type { Money } from '../../../shared/money';

export type WagerTransactionKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerTransactionStatus = 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED' | 'FAILED';

interface WagerTransactionBaseProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  idempotencyKey: string;
  payloadHash: string;
}

export type ProcessedWagerTransactionProps = WagerTransactionBaseProps;

export interface RejectedWagerTransactionProps extends WagerTransactionBaseProps {
  failureCode: string;
}

export interface RehydrateWagerTransactionProps extends WagerTransactionBaseProps {
  status: WagerTransactionStatus;
  failureCode?: string;
  // Story 2.4 — always `undefined` today (only BET/OPENING exist, neither ever references
  // another transaction); carried through so `GET /wagering/transactions/:id` already has the
  // right shape once Story 2.3 starts setting it on REFUND/ROLLBACK rows.
  referenceTransactionId?: string;
}

export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly playerId: string,
    readonly walletId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly status: WagerTransactionStatus,
    readonly money: Money,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly failureCode?: string,
    readonly referenceTransactionId?: string,
  ) {}

  static processed(props: ProcessedWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.playerId,
      props.walletId,
      props.roundId,
      props.gameId,
      props.kind,
      'PROCESSED',
      props.money,
      props.idempotencyKey,
      props.payloadHash,
      undefined,
    );
  }

  static rejected(props: RejectedWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.playerId,
      props.walletId,
      props.roundId,
      props.gameId,
      props.kind,
      'REJECTED',
      props.money,
      props.idempotencyKey,
      props.payloadHash,
      props.failureCode,
    );
  }

  /** Reconstruction from persistence — does not re-run any transition rule. */
  static rehydrate(props: RehydrateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.playerId,
      props.walletId,
      props.roundId,
      props.gameId,
      props.kind,
      props.status,
      props.money,
      props.idempotencyKey,
      props.payloadHash,
      props.failureCode,
      props.referenceTransactionId,
    );
  }

  /** True when `payloadHash` matches — the idempotency-key replay-vs-conflict decision. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
