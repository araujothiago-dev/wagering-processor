// Story 1.2 — creates the four tables the wallet module writes to in this story
// (ARCHITECTURE.md "Schema"). Hand-written (not `synchronize`) but built with the same
// `Table`/`queryRunner.createTable()` API `synchronize` itself uses internally
// (`RdbmsSchemaBuilder`), so the generated DDL matches what the entities in
// `modules/wallet/infrastructure/*.entity.ts` describe, column for column, constraint for
// constraint — not just "close enough" raw SQL typed by hand.
import { MigrationInterface, QueryRunner, Table, TableForeignKey } from 'typeorm';

export class CreateWalletSchema1788004800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'wallets',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true },
          { name: 'player_id', type: 'varchar' },
          { name: 'currency', type: 'varchar' },
          { name: 'balance_amount', type: 'numeric', precision: 20, scale: 2 },
          { name: 'version', type: 'int' },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
        ],
        uniques: [{ name: 'UQ_wallets_player_currency', columnNames: ['player_id', 'currency'] }],
        checks: [
          {
            name: 'CHK_wallets_balance_amount_non_negative',
            columnNames: ['balance_amount'],
            expression: '"balance_amount" >= 0',
          },
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'wager_transactions',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true },
          { name: 'wallet_id', type: 'uuid' },
          { name: 'kind', type: 'varchar' },
          { name: 'status', type: 'varchar' },
          { name: 'amount', type: 'numeric', precision: 20, scale: 2 },
          { name: 'idempotency_key', type: 'varchar', isNullable: true },
          { name: 'reference_transaction_id', type: 'uuid', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
        ],
        uniques: [
          { name: 'UQ_wager_transactions_idempotency_key', columnNames: ['idempotency_key'] },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_wager_transactions_wallet_id',
            columnNames: ['wallet_id'],
            referencedTableName: 'wallets',
            referencedColumnNames: ['id'],
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'wallet_ledger_entries',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true },
          { name: 'wallet_id', type: 'uuid' },
          { name: 'wager_transaction_id', type: 'uuid' },
          { name: 'direction', type: 'varchar' },
          { name: 'amount', type: 'numeric', precision: 20, scale: 2 },
          { name: 'balance_before', type: 'numeric', precision: 20, scale: 2 },
          { name: 'balance_after', type: 'numeric', precision: 20, scale: 2 },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_wallet_ledger_entries_wallet_id',
            columnNames: ['wallet_id'],
            referencedTableName: 'wallets',
            referencedColumnNames: ['id'],
          }),
          new TableForeignKey({
            name: 'FK_wallet_ledger_entries_wager_transaction_id',
            columnNames: ['wager_transaction_id'],
            referencedTableName: 'wager_transactions',
            referencedColumnNames: ['id'],
          }),
        ],
      }),
    );

    await queryRunner.createTable(
      new Table({
        name: 'outbox_messages',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true },
          { name: 'type', type: 'varchar' },
          { name: 'payload', type: 'jsonb' },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'next_attempt_at', type: 'timestamptz', isNullable: true },
          { name: 'published_at', type: 'timestamptz', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'now()' },
        ],
      }),
    );

    // Defense in depth (ARCHITECTURE.md "Ledger"): the app connects as `DB_USER`, never a
    // superuser, so this actually blocks UPDATE/DELETE for that role — Postgres lets an object
    // owner revoke their own ordinary privileges, it isn't only a grant for other roles.
    const appRole = process.env.DB_USER ?? 'wagering';
    await queryRunner.query(
      `REVOKE UPDATE, DELETE ON "wallet_ledger_entries" FROM "${appRole}"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('outbox_messages');
    await queryRunner.dropTable('wallet_ledger_entries');
    await queryRunner.dropTable('wager_transactions');
    await queryRunner.dropTable('wallets');
  }
}
