// `wallet/interface` — WalletController (Story 1.2).
//
// Rule (AD-2): this layer calls only `application` use cases — never `infrastructure`
// repositories directly. Body parsing is manual (no DTO class + ValidationPipe, matching spec
// "parse manual do body") — this is the one place that narrows an untyped JSON body into a
// `CreateWalletCommand`, so it's also the one place that must reject a malformed request before
// it ever reaches `Wallet.open`/`Money.of` (which trust their inputs are already the right type).
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import type { CreateWalletCommand } from '../application/create-wallet.use-case';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';

export class WalletRequestValidationError extends Error {
  readonly code = 'VALIDATION_INVALID_REQUEST' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WalletRequestValidationError';
  }
}

interface CreateWalletResponseBody {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

@Controller('wallets')
export class WalletController {
  constructor(private readonly createWalletUseCase: CreateWalletUseCase) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<CreateWalletResponseBody> {
    const command = this.parseCreateWalletBody(body);
    const wallet = await this.createWalletUseCase.execute(command);

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
    };
  }

  private parseCreateWalletBody(body: unknown): CreateWalletCommand {
    if (typeof body !== 'object' || body === null) {
      throw new WalletRequestValidationError('Request body must be a JSON object.');
    }

    const { playerId, currency, initialBalance } = body as Record<string, unknown>;

    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw new WalletRequestValidationError('"playerId" must be a non-empty string.');
    }

    if (typeof currency !== 'string' || currency.length === 0) {
      throw new WalletRequestValidationError('"currency" must be a non-empty string.');
    }

    if (initialBalance !== undefined && typeof initialBalance !== 'string') {
      throw new WalletRequestValidationError('"initialBalance" must be a string when provided.');
    }

    return { playerId, currency, initialBalance };
  }
}
