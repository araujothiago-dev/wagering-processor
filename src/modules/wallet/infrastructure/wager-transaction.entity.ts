// `wallet/infrastructure` — TypeORM mapping for the `wager_transactions` table (Story 1.2,
// ARCHITECTURE.md "Schema" / "Design Notes").
//
// `kind`/`status` pre-declare the full Epic 2/3 vocabulary already (not just `OPENING`/
// `PROCESSED`, the only values this story writes) so a later story never needs an `ALTER TYPE`/
// incremental migration just to add an enum value. This story never constructs a full
// `WagerTransaction` aggregate (that lands with `wagering/domain` in Epic 2/3) — the OPENING row
// is written directly by `wallet/infrastructure`, see spec "Design Notes".
import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

export type WagerTransactionKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerTransactionStatus = 'PROCESSED' | 'PENDING_REFERENCE' | 'REJECTED' | 'FAILED';

@Entity({ name: 'wager_transactions' })
@Unique('UQ_wager_transactions_idempotency_key', ['idempotencyKey'])
export class WagerTransactionEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Column({ type: 'varchar' })
  kind!: WagerTransactionKind;

  @Column({ type: 'varchar' })
  status!: WagerTransactionStatus;

  @Column({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Column({ name: 'idempotency_key', type: 'varchar', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
