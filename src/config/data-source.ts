import 'reflect-metadata';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { dbEnvSchema } from './env.validation';

/**
 * Reads directly from process.env (not the Nest ConfigService) because this module is the
 * entry point for two contexts that run outside the Nest DI container: the TypeORM CLI and
 * the one-shot migration runner script (src/scripts/run-migrations.ts).
 *
 * No table migrations exist yet in this story (Story 1.1 is scaffolding-only) — the
 * `migrations` glob simply resolves to an empty set until Story 1.2 adds the first one.
 *
 * Validated against the same `dbEnvSchema` the Nest app uses (env.validation.ts) — this entry
 * point must fail fast on a missing/malformed DB var too, exactly like the HTTP app does,
 * instead of silently falling back to values that happen to match docker-compose's defaults
 * (verification-gap finding, Story 1.1 review).
 */
export function buildDataSourceOptions(env: NodeJS.ProcessEnv = process.env): DataSourceOptions {
  const { error, value } = dbEnvSchema.validate(env, { allowUnknown: true, stripUnknown: false });
  if (error) {
    throw new Error(`Invalid database configuration: ${error.message}`);
  }

  return {
    type: 'postgres',
    host: value.DB_HOST as string,
    port: value.DB_PORT as number,
    username: value.DB_USER as string,
    password: value.DB_PASSWORD as string,
    database: value.DB_NAME as string,
    entities: [`${__dirname}/../modules/**/*.entity.{ts,js}`],
    migrations: [`${__dirname}/../migrations/*.{ts,js}`],
    synchronize: false,
    migrationsRun: false,
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());
