// Story 1.3 fix-forward — `created_at` on all four Story 1.2 tables was `timestamp` (no time
// zone). node-postgres hydrates that as a JS `Date` by treating the naive stored value as being
// in the *client process's local timezone*, not UTC. On any machine whose Node process doesn't
// run in UTC, that silently shifts every read `created_at` by the local UTC offset. Story 1.3's
// keyset ledger cursor is built from `entry.createdAt.toISOString()`, so this shift corrupted
// pagination (a page boundary compared against a `created_at` that never existed in the table).
// `timestamptz` stores an absolute instant — no naive-value ambiguity on read, regardless of the
// reading process's timezone.
//
// `USING "created_at" AT TIME ZONE 'UTC'` reinterprets every existing naive value as already
// being UTC, which is safe only in this project's context: the bug was read-side only (writes
// always went through `now()`/`CURRENT_TIMESTAMP`, which Postgres itself evaluates in UTC when
// the server's `timezone` setting is UTC, as this stack's docker-compose Postgres is configured),
// and there is no pre-existing production data — this is a fresh local/CI database every time. A
// deployment carrying real historical rows written under a Postgres session with a non-UTC
// `timezone` setting would need a different `USING` clause (converting from that session's zone,
// not assuming UTC) to avoid silently shifting those old rows.
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'outbox_messages'];

export class FixCreatedAtTimezone1788008400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC'`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "created_at" TYPE timestamp USING "created_at" AT TIME ZONE 'UTC'`,
      );
    }
  }
}
