// Story 2.1 — adds the request/decision fields a `BET` (and future WIN/LOSS/REFUND/ROLLBACK)
// submission carries to `wager_transactions`, on top of the four Story 1.2 tables
// (`CreateWalletSchema1788004800000`). All seven columns are nullable: the `OPENING` rows
// Story 1.2 writes populate none of them, and this migration must not break that existing data.
import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

const NEW_COLUMNS = [
  new TableColumn({ name: 'provider_id', type: 'varchar', isNullable: true }),
  new TableColumn({ name: 'external_transaction_id', type: 'varchar', isNullable: true }),
  new TableColumn({ name: 'player_id', type: 'varchar', isNullable: true }),
  new TableColumn({ name: 'round_id', type: 'varchar', isNullable: true }),
  new TableColumn({ name: 'game_id', type: 'varchar', isNullable: true }),
  new TableColumn({ name: 'payload_hash', type: 'varchar', isNullable: true }),
  new TableColumn({ name: 'failure_code', type: 'varchar', isNullable: true }),
];

const NEW_COLUMN_NAMES = NEW_COLUMNS.map((column) => column.name);

export class AddWagerTransactionBusinessColumns1788012000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('wager_transactions', NEW_COLUMNS);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumns('wager_transactions', NEW_COLUMN_NAMES);
  }
}
