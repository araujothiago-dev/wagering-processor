import Joi from 'joi';

/**
 * DB-only subset, reused by both the full app schema below and `data-source.ts` (the TypeORM
 * CLI / one-shot migration runner entry point, which never touches SQS config and must not be
 * forced to require it just to reuse this validation).
 */
export const dbEnvSchema = Joi.object({
  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USER: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
}).unknown(true);

/**
 * Validated at boot by ConfigModule (AD: "Config" convention in ARCHITECTURE.md).
 * The process fails fast if any required variable is missing or malformed.
 */
export const envValidationSchema = dbEnvSchema.keys({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),

  SQS_ENDPOINT: Joi.string().uri().required(),
  SQS_REGION: Joi.string().default('us-east-1'),
});
