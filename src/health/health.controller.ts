import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

/**
 * Both endpoints are intentionally public (AD-9 / spec-1-1): no AuthGuard applies to
 * `/health/*`, and neither handler ever lets an exception escape uncaught — `checkReadiness`
 * already isolates each dependency failure via Promise.allSettled.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  live(): { status: 'ok' } {
    return this.healthService.checkLiveness();
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async ready(): Promise<{ status: 'ok'; postgres: true; sqs: true }> {
    const result = await this.healthService.checkReadiness();

    if (!result.ready) {
      throw new ServiceUnavailableException({
        error: {
          code: 'SERVICE_NOT_READY',
          message: 'One or more dependencies are unreachable.',
          details: { postgres: result.postgres, sqs: result.sqs },
        },
      });
    }

    return { status: 'ok', postgres: true, sqs: true };
  }
}
