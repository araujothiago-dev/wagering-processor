import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_CLIENT } from './sqs-client.provider';

export interface ReadinessResult {
  ready: boolean;
  postgres: boolean;
  sqs: boolean;
}

const READINESS_CHECK_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Design Notes (spec-1-1): `live` is always OK if the process can respond; `ready` runs both
 * dependency checks in parallel via Promise.allSettled so a failure in one never throws an
 * unhandled exception or blocks the other — the controller maps the result to an HTTP status.
 * Both checks are bounded by the same timeout (blind-hunter review, Story 1.1: checkPostgres
 * previously had no bound, unlike checkSqs's client-level timeout — a hung connection could
 * make /health/ready hang instead of failing fast).
 */
@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
  ) {}

  checkLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async checkReadiness(): Promise<ReadinessResult> {
    const [postgres, sqs] = await Promise.allSettled([this.checkPostgres(), this.checkSqs()]);

    const postgresOk = postgres.status === 'fulfilled';
    const sqsOk = sqs.status === 'fulfilled';

    return {
      ready: postgresOk && sqsOk,
      postgres: postgresOk,
      sqs: sqsOk,
    };
  }

  private async checkPostgres(): Promise<void> {
    await withTimeout(this.dataSource.query('SELECT 1'), READINESS_CHECK_TIMEOUT_MS, 'postgres check');
  }

  private async checkSqs(): Promise<void> {
    await this.sqsClient.send(new ListQueuesCommand({}));
  }
}
