import type { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

/**
 * Factory consumed by TypeOrmModule.forRootAsync in AppModule. Mirrors buildDataSourceOptions
 * (src/config/data-source.ts) but sources values from the validated Nest ConfigService instead
 * of raw process.env, since this factory only ever runs inside the Nest DI container.
 */
export function buildTypeOrmModuleOptions(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: config.get<string>('DB_HOST'),
    port: config.get<number>('DB_PORT'),
    username: config.get<string>('DB_USER'),
    password: config.get<string>('DB_PASSWORD'),
    database: config.get<string>('DB_NAME'),
    entities: [`${__dirname}/../modules/**/*.entity.{ts,js}`],
    migrations: [`${__dirname}/../migrations/*.{ts,js}`],
    synchronize: false,
    migrationsRun: false,
    autoLoadEntities: false,
  };
}
