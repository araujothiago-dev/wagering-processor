import { describe, expect, it, mock } from 'bun:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { HealthService } from './health.service';

describe('HealthController', () => {
  it('live() returns 200-shaped payload synchronously', () => {
    const service = {
      checkLiveness: mock(() => ({ status: 'ok' as const })),
    } as unknown as HealthService;
    const controller = new HealthController(service);
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('ready() returns ok payload when dependencies are reachable', async () => {
    const service = {
      checkReadiness: mock(() => Promise.resolve({ ready: true, postgres: true, sqs: true })),
    } as unknown as HealthService;
    const controller = new HealthController(service);
    await expect(controller.ready()).resolves.toEqual({ status: 'ok', postgres: true, sqs: true });
  });

  it('ready() throws ServiceUnavailableException (503) when a dependency is down', async () => {
    const service = {
      checkReadiness: mock(() => Promise.resolve({ ready: false, postgres: false, sqs: true })),
    } as unknown as HealthService;
    const controller = new HealthController(service);
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
