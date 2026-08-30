// `wallet/infrastructure` — TypeORM mapping for the `wager_transactions` table (Story 1.2,
// extended Story 2.1, ARCHITECTURE.md "Schema" / "Design Notes").
//
// `kind`/`status` pre-declare the full Epic 2/3 vocabulary already (not just `OPENING`/
// `PROCESSED`, the only values Story 1.2 wrote) so a later story never needs an `ALTER TYPE`/
// incremental migration just to add an enum value. `WagerTransactionEntity` stays in
// `wallet/infrastructure` rather than moving to `wagering/infrastructure` (spec "Design Notes":
// moving it would just invert the import direction for `CreateWalletTransactionalWriterImpl`,
// which still writes the OPENING row directly here) — only the **types** move to
// `wagering/domain`, which is the vocabulary's canonical home starting Story 2.1.
//
// `provider_id`/`external_transaction_id`/`player_id`/`round_id`/`game_id`/`payload_hash`/
// `failure_code` are new in Story 2.1, all nullable — the `OPENING` rows Story 1.2 writes never
// populate them.
import { Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction';

export type { WagerTransactionKind, WagerTransactionStatus };

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

  // Story 2.1 — the request fields a BET (and future WIN/LOSS/REFUND/ROLLBACK) submission
  // carries, needed to rehydrate a `WagerTransaction` on an idempotency-key replay/conflict read
  // (`SubmitBetTransactionalWriterImpl`). Nullable: pre-2.1 `OPENING` rows have none of these.
  @Column({ name: 'provider_id', type: 'varchar', nullable: true })
  providerId!: string | null;

  @Column({ name: 'external_transaction_id', type: 'varchar', nullable: true })
  externalTransactionId!: string | null;

  @Column({ name: 'player_id', type: 'varchar', nullable: true })
  playerId!: string | null;

  @Column({ name: 'round_id', type: 'varchar', nullable: true })
  roundId!: string | null;

  @Column({ name: 'game_id', type: 'varchar', nullable: true })
  gameId!: string | null;

  @Column({ name: 'payload_hash', type: 'varchar', nullable: true })
  payloadHash!: string | null;

  @Column({ name: 'failure_code', type: 'varchar', nullable: true })
  failureCode!: string | null;

  // `timestamptz`, not the driver's default `timestamp` — see wallet.entity.ts for why.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
