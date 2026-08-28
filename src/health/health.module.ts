import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { sqsClientProvider } from './sqs-client.provider';

@Module({
  controllers: [HealthController],
  providers: [HealthService, sqsClientProvider],
})
export class HealthModule {}
