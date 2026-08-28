import { SQSClient } from '@aws-sdk/client-sqs';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

const SQS_CHECK_TIMEOUT_MS = 2000;

/**
 * MiniStack does not require real AWS credentials (AD-11), so any non-empty static
 * credentials satisfy the SDK's client construction requirements.
 */
export const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): SQSClient => {
    return new SQSClient({
      endpoint: config.get<string>('SQS_ENDPOINT'),
      region: config.get<string>('SQS_REGION'),
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        requestTimeout: SQS_CHECK_TIMEOUT_MS,
        connectionTimeout: SQS_CHECK_TIMEOUT_MS,
      }),
    });
  },
};
