// `wallet/infrastructure` — TypeORM mapping for the `outbox_messages` table (Story 1.2,
// ARCHITECTURE.md "Outbox transacional"). `attempts`/`next_attempt_at`/`published_at` exist from
// this story onward even though the publisher (the `@Cron`/`@Interval` worker that claims rows
// via `FOR UPDATE SKIP LOCKED`) is Epic 3 scope — this story only ever inserts a row, never
// publishes it.
//
// `payload` is free-form JSON on purpose: `shared/events` (typed event contracts) only exists
// starting Epic 3.
import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar' })
  type!: string;

  // Typed `unknown` (not `Record<string, unknown>`) so TypeORM's QueryDeepPartialEntity mapper
  // doesn't try to recurse into the free-form payload shape at the call site.
  @Column({ type: 'jsonb' })
  payload!: unknown;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
