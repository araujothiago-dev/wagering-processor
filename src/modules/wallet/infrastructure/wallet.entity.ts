// `wallet/infrastructure` — TypeORM mapping for the `wallets` table (Story 1.2,
// ARCHITECTURE.md "Schema").
import { Check, Column, CreateDateColumn, Entity, PrimaryColumn, Unique } from 'typeorm';

// Referenced by name from `create-wallet.transactional-writer.ts` to recognize the specific
// unique-violation this story translates into `WalletAlreadyExistsError` (never by a prior read).
export const WALLET_PLAYER_CURRENCY_UNIQUE_CONSTRAINT = 'UQ_wallets_player_currency';

@Entity({ name: 'wallets' })
@Unique(WALLET_PLAYER_CURRENCY_UNIQUE_CONSTRAINT, ['playerId', 'currency'])
@Check('CHK_wallets_balance_amount_non_negative', '"balance_amount" >= 0')
export class WalletEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'player_id', type: 'varchar' })
  playerId!: string;

  @Column({ type: 'varchar' })
  currency!: string;

  // Numeric columns round-trip as plain strings with the postgres driver (no implicit
  // parseFloat) — Money's decimal string can be stored/read as-is, no ValueTransformer needed.
  @Column({ name: 'balance_amount', type: 'numeric', precision: 20, scale: 2 })
  balanceAmount!: string;

  // Audit counter (FR19) — not the concurrency mechanism, see ARCHITECTURE.md "Concorrência".
  @Column({ type: 'int' })
  version!: number;

  // `timestamptz`, not the driver's default `timestamp` — a naive `timestamp` round-trips
  // through node-postgres as a JS `Date` shifted by the Node process's local timezone offset
  // (Story 1.3 finding). `timestamptz` stores an absolute instant, no ambiguity either way.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
