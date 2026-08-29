// `wallet/application` ports (Story 1.2). Pure interfaces — no NestJS/TypeORM import (AD-2);
// `infrastructure` provides the concrete adapters that implement them.
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

// Forward-declared for the read paths of a later story (`GET /wallets/:id`,
// `interface/index.ts`). Not consumed by `CreateWalletUseCase` — creation never reads before
// inserting (that would race), it only relies on the unique constraint violation.
export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
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
