import { describe, expect, it, mock } from 'bun:test';
import { HealthService } from './health.service';
import type { DataSource } from 'typeorm';
import type { SQSClient } from '@aws-sdk/client-sqs';

function buildService(opts: { postgresOk: boolean; sqsOk: boolean }): HealthService {
  const dataSource = {
    query: mock(() =>
      opts.postgresOk ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('down')),
    ),
  } as unknown as DataSource;

  const sqsClient = {
    send: mock(() =>
      opts.sqsOk ? Promise.resolve({ QueueUrls: [] }) : Promise.reject(new Error('down')),
    ),
  } as unknown as SQSClient;

  return new HealthService(dataSource, sqsClient);
}

describe('HealthService', () => {
  it('checkLiveness always reports ok', () => {
    const service = buildService({ postgresOk: true, sqsOk: true });
    expect(service.checkLiveness()).toEqual({ status: 'ok' });
  });

  it('checkReadiness reports ready when both dependencies are reachable', async () => {
    const service = buildService({ postgresOk: true, sqsOk: true });
    const result = await service.checkReadiness();
    expect(result).toEqual({ ready: true, postgres: true, sqs: true });
  });

  it('checkReadiness reports not ready when Postgres is unreachable, without throwing', async () => {
    const service = buildService({ postgresOk: false, sqsOk: true });
    const result = await service.checkReadiness();
    expect(result).toEqual({ ready: false, postgres: false, sqs: true });
  });

  it('checkReadiness reports not ready when SQS is unreachable, without throwing', async () => {
    const service = buildService({ postgresOk: true, sqsOk: false });
    const result = await service.checkReadiness();
    expect(result).toEqual({ ready: false, postgres: true, sqs: false });
  });

  it('checkReadiness reports not ready when both dependencies are unreachable', async () => {
    const service = buildService({ postgresOk: false, sqsOk: false });
    const result = await service.checkReadiness();
    expect(result).toEqual({ ready: false, postgres: false, sqs: false });
  });
});
