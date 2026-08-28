import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Read PORT through the already-validated ConfigService (Joi's `.port().default(3000)` in
  // env.validation.ts), not raw process.env — a malformed PORT must fail at ConfigModule boot,
  // not silently become NaN here (blind-hunter + edge-case-hunter finding, Story 1.1 review).
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') ?? 3000;
  await app.listen(port);
}

bootstrap().catch((error: unknown) => {
  // Config validation and DB bootstrap failures must fail fast, not hang as an unhandled
  // rejection (Config convention, ARCHITECTURE.md: "processo falha rapido se invalido").
  console.error('[bootstrap] failed to start:', error);
  process.exit(1);
});
