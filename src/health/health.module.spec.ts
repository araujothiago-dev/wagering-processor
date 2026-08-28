import { describe, expect, it, mock } from 'bun:test';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SQS_CLIENT } from './sqs-client.provider';

/**
 * Unlike health.controller.spec.ts / health.service.spec.ts (which `new` the classes directly,
 * bypassing Nest's DI entirely), this test resolves HealthController/HealthService through a
 * real Nest DI container at their actual injection tokens (`getDataSourceToken()`, `SQS_CLIENT`)
 * instead of manual constructor calls. A wrong token or a missing `@Injectable()`/`@Inject()`
 * would fail module compilation here — none of that is caught by the mocked-in-isolation unit
 * tests (blind-hunter finding, Story 1.1 review).
 *
 * Providers are declared directly here rather than importing HealthModule + overrideProvider:
 * `overrideProvider` only replaces a token HealthModule already declares, and HealthModule
 * intentionally does not declare `DataSource` itself (it comes from AppModule's
 * `TypeOrmModule.forRootAsync` in the real app) — there would be nothing to override.
 */
describe('HealthModule (DI wiring)', () => {
  it('resolves HealthController through real Nest DI and serves /health/live and /health/ready', async () => {
    const dataSource = { query: mock(() => Promise.resolve([{ '?column?': 1 }])) } as unknown as DataSource;
    const sqsClient = { send: mock(() => Promise.resolve({ QueueUrls: [] })) } as unknown as SQSClient;

    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        HealthService,
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: SQS_CLIENT, useValue: sqsClient },
      ],
    }).compile();

    const controller = moduleRef.get(HealthController);

    expect(controller.live()).toEqual({ status: 'ok' });
    await expect(controller.ready()).resolves.toEqual({ status: 'ok', postgres: true, sqs: true });

    await moduleRef.close();
  });
});
