// `wallet/application` ports (Story 1.2). Pure interfaces — no NestJS/TypeORM import (AD-2);
// `infrastructure` provides the concrete adapters that implement them.
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

// Story 1.2 forward-declared this for the read paths; Story 1.3 is the first consumer
// (`GetWalletUseCase`, `GetWalletLedgerUseCase`). Not consumed by `CreateWalletUseCase` —
// creation never reads before inserting (that would race), it only relies on the unique
// constraint violation.
export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
}

// Story 1.3 — keyset pagination over `wallet_ledger_entries` for one wallet. `cursor` is the
// opaque string from the previous page's `nextCursor` (or `undefined` for the first page);
// this port never sees its decoded shape — decoding (and rejecting a malformed one with
// `LedgerCursorError`) is the concrete adapter's job (`ledger-cursor.codec.ts`), so this
// interface stays free of any infrastructure import (AD-2).
//
// `currency` travels alongside `walletId` because `wallet_ledger_entries` itself carries no
// currency column (it belongs to the wallet, not the entry) — the use case already has it from
// the `WalletRepository.findById` existence check, so it passes it through rather than the
// adapter re-querying `wallets`.
export interface ListWalletLedgerParams {
  walletId: string;
  currency: string;
  limit: number;
  cursor?: string;
}

export interface ListWalletLedgerResult {
  entries: WalletLedgerEntry[];
  // Present only when there are more than `limit` entries past this page.
  nextCursor?: string;
}

export interface WalletLedgerRepository {
  list(params: ListWalletLedgerParams): Promise<ListWalletLedgerResult>;
}

export interface WalletBalanceChangedOutboxMessage {
  type: 'WalletBalanceChanged';
  walletId: string;
  playerId: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  wagerTransactionId: string;
  occurredAt: string;
}

export interface CreateWalletOpeningWrite {
  wagerTransactionId: string;
  ledgerEntry: WalletLedgerEntry;
  outboxMessage: WalletBalanceChangedOutboxMessage;
}

export interface CreateWalletWriteCommand {
  wallet: Wallet;
  opening?: CreateWalletOpeningWrite;
}

export interface CreateWalletTransactionalWriter {
  /**
   * Persists the wallet — and, when `opening` is present, the OPENING wager_transaction row,
   * the wallet_ledger_entries row, and the outbox_messages row — in a single SQL transaction.
   * No event is published here; that is the outbox publisher's job (Epic 3).
   *
   * Rejects with `WalletAlreadyExistsError` when (playerId, currency) already has a wallet,
   * detected by the unique constraint violation on insert — never by a prior read.
   */
  write(command: CreateWalletWriteCommand): Promise<void>;
}
