// `wallet/infrastructure` — TypeORM mapping for the `wallet_ledger_entries` table (Story 1.2,
// ARCHITECTURE.md "Ledger"). No update/delete path exists anywhere in this codebase for this
// table by design — the migration additionally revokes the privilege at the database role level
// as defense in depth (see spec "Code Map").
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { WalletLedgerEntryDirection } from '../domain/wallet-ledger-entry';

@Entity({ name: 'wallet_ledger_entries' })
export class WalletLedgerEntryEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ name: 'wager_transaction_id', type: 'uuid' })
  wagerTransactionId!: string;

  @Column({ type: 'varchar' })
  direction!: WalletLedgerEntryDirection;

  @Column({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Column({ name: 'balance_before', type: 'numeric', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Column({ name: 'balance_after', type: 'numeric', precision: 20, scale: 2 })
  balanceAfter!: string;

  // `timestamptz`, not the driver's default `timestamp` — see wallet.entity.ts for why. This is
  // the column the keyset pagination cursor (Story 1.3) is built from, so the bug this fixes
  // isn't cosmetic: a naive `timestamp` silently corrupts cursor comparisons off UTC.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
