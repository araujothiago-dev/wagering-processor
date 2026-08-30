// `wagering/interface` — WageringController (Story 2.1 create; Story 2.4 read endpoints).
//
// Rule (AD-2): this layer calls only `application` use cases — never `infrastructure`
// repositories directly. Body/header parsing is manual (no DTO class + ValidationPipe, matching
// `wallet/interface/wallet.controller.ts`'s pattern) — this is the one place that narrows an
// untyped JSON body / header into a typed command, so it's also the one place that must reject
// a malformed request before it ever reaches the use case (which always acquires the wallet
// lock — a request rejected here never does).
//
// No class-level `@Controller('wagering/transactions')` prefix: the provider-scoped read route
// (`/providers/:providerId/wagering/transactions/:externalId`) lives under a completely
// different path, not nested under it — so every route below spells out its own full path.
import { Controller, Body, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import type { SubmitBetCommand } from '../application/submit-bet.use-case';
import { SubmitBetUseCase } from '../application/submit-bet.use-case';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import type { WagerTransaction } from '../domain/wager-transaction';

export type WageringRequestValidationErrorCode =
  | 'VALIDATION_INVALID_REQUEST'
  | 'VALIDATION_MISSING_IDEMPOTENCY_KEY'
  | 'VALIDATION_UNSUPPORTED_KIND';

export class WageringRequestValidationError extends Error {
  readonly code: WageringRequestValidationErrorCode;

  constructor(message: string, code: WageringRequestValidationErrorCode = 'VALIDATION_INVALID_REQUEST') {
    super(message);
    this.name = 'WageringRequestValidationError';
    this.code = code;
  }
}

const SUPPORTED_KIND = 'BET';
const REQUIRED_STRING_FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'amount',
  'currency',
] as const;

interface SubmitBetResponseBody {
  transactionId: string;
  status: string;
  balance: string;
  currency: string;
  idempotentReplay: boolean;
}

interface WagerTransactionResponseBody {
  transactionId: string;
  status: string;
  kind: string;
  amount: string;
  currency: string;
  referenceTransactionId?: string;
}

@Controller()
export class WageringController {
  constructor(
    private readonly submitBetUseCase: SubmitBetUseCase,
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post('wagering/transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<SubmitBetResponseBody> {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new WageringRequestValidationError(
        'Header "Idempotency-Key" is required.',
        'VALIDATION_MISSING_IDEMPOTENCY_KEY',
      );
    }

    const command = this.parseSubmitBetBody(body, idempotencyKey);
    const result = await this.submitBetUseCase.execute(command);

    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance.amount,
      currency: result.currency,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string): Promise<WagerTransactionResponseBody> {
    const transaction = await this.getWagerTransactionUseCase.byId(transactionId);
    return this.toWagerTransactionResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponseBody> {
    const transaction = await this.getWagerTransactionUseCase.byProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
    return this.toWagerTransactionResponse(transaction);
  }

  private toWagerTransactionResponse(transaction: WagerTransaction): WagerTransactionResponseBody {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      kind: transaction.kind,
      amount: transaction.money.amount,
      currency: transaction.money.currency,
      referenceTransactionId: transaction.referenceTransactionId,
    };
  }

  private parseSubmitBetBody(body: unknown, idempotencyKey: string): SubmitBetCommand {
    if (typeof body !== 'object' || body === null) {
      throw new WageringRequestValidationError('Request body must be a JSON object.');
    }

    const fields = body as Record<string, unknown>;

    for (const field of REQUIRED_STRING_FIELDS) {
      const value = fields[field];
      if (typeof value !== 'string' || value.length === 0) {
        throw new WageringRequestValidationError(`"${field}" must be a non-empty string.`);
      }
    }

    const kind = fields.kind as string;
    if (kind !== SUPPORTED_KIND) {
      throw new WageringRequestValidationError(
        `"kind" must be '${SUPPORTED_KIND}', got '${kind}'.`,
        'VALIDATION_UNSUPPORTED_KIND',
      );
    }

    return {
      providerId: fields.providerId as string,
      externalTransactionId: fields.externalTransactionId as string,
      playerId: fields.playerId as string,
      walletId: fields.walletId as string,
      roundId: fields.roundId as string,
      gameId: fields.gameId as string,
      amount: fields.amount as string,
      currency: fields.currency as string,
      idempotencyKey,
    };
  }
}
