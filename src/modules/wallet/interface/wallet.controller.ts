// `wallet/interface` — WalletController (Story 1.2 create; Story 1.3 read endpoints).
//
// Rule (AD-2): this layer calls only `application` use cases — never `infrastructure`
// repositories directly. Body/query parsing is manual (no DTO class + ValidationPipe, matching
// spec "parse manual do body") — this is the one place that narrows an untyped JSON body /
// query string into a typed command, so it's also the one place that must reject a malformed
// request before it ever reaches a use case or a query (`Wallet.open`/`Money.of` trust their
// inputs are already the right type; the same is true of `walletId` reaching a Postgres query —
// it's validated as a UUID here, never left to surface the driver's raw
// `invalid input syntax for type uuid` as a 500).
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import type { CreateWalletCommand } from '../application/create-wallet.use-case';
import { CreateWalletUseCase } from '../application/create-wallet.use-case';
import { GetWalletLedgerUseCase } from '../application/get-wallet-ledger.use-case';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { ReconciliationResult } from '../domain/reconciliation';

const WALLET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LEDGER_LIMIT = 50;
const MAX_LEDGER_LIMIT = 100;
const INTEGER_PATTERN = /^\d+$/;

export type WalletRequestValidationErrorCode =
  | 'VALIDATION_INVALID_REQUEST'
  | 'VALIDATION_INVALID_WALLET_ID'
  | 'VALIDATION_INVALID_LIMIT';

export class WalletRequestValidationError extends Error {
  readonly code: WalletRequestValidationErrorCode;

  constructor(message: string, code: WalletRequestValidationErrorCode = 'VALIDATION_INVALID_REQUEST') {
    super(message);
    this.name = 'WalletRequestValidationError';
    this.code = code;
  }
}

interface WalletResponseBody {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
}

interface WalletLedgerEntryResponseBody {
  direction: WalletLedgerEntry['direction'];
  money: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: string;
}

interface GetWalletLedgerResponseBody {
  entries: WalletLedgerEntryResponseBody[];
  nextCursor?: string;
}

interface ReconciliationResponseBody {
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  consistent: boolean;
  checkedEntries: number;
}

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly createWalletUseCase: CreateWalletUseCase,
    private readonly getWalletUseCase: GetWalletUseCase,
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WalletResponseBody> {
    const command = this.parseCreateWalletBody(body);
    const wallet = await this.createWalletUseCase.execute(command);

    return this.toWalletResponse(wallet);
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string): Promise<WalletResponseBody> {
    this.assertValidWalletId(walletId);

    const wallet = await this.getWalletUseCase.execute({ walletId });

    return this.toWalletResponse(wallet);
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursorRaw?: string,
  ): Promise<GetWalletLedgerResponseBody> {
    this.assertValidWalletId(walletId);
    const limit = this.parseLimit(limitRaw);

    const result = await this.getWalletLedgerUseCase.execute({
      walletId,
      limit,
      cursor: cursorRaw,
    });

    return {
      entries: result.entries.map((entry) => this.toLedgerEntryResponse(entry)),
      nextCursor: result.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationResponseBody> {
    this.assertValidWalletId(walletId);

    const result = await this.reconcileWalletUseCase.execute({ walletId });

    return this.toReconciliationResponse(result);
  }

  private toWalletResponse(wallet: Wallet): WalletResponseBody {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
    };
  }

  private toLedgerEntryResponse(entry: WalletLedgerEntry): WalletLedgerEntryResponseBody {
    return {
      direction: entry.direction,
      money: entry.money.amount,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      createdAt: entry.createdAt.toISOString(),
    };
  }

  private toReconciliationResponse(result: ReconciliationResult): ReconciliationResponseBody {
    return {
      storedBalance: result.storedBalance.amount,
      calculatedBalance: result.calculatedBalance.amount,
      difference: result.difference.amount,
      consistent: result.consistent,
      checkedEntries: result.checkedEntries,
    };
  }

  private assertValidWalletId(walletId: string): void {
    if (!WALLET_ID_PATTERN.test(walletId)) {
      throw new WalletRequestValidationError(
        `"walletId" must be a UUID, got '${walletId}'.`,
        'VALIDATION_INVALID_WALLET_ID',
      );
    }
  }

  private parseLimit(raw: string | undefined): number {
    if (raw === undefined) {
      return DEFAULT_LEDGER_LIMIT;
    }

    if (!INTEGER_PATTERN.test(raw)) {
      throw new WalletRequestValidationError(
        `"limit" must be a positive integer, got '${raw}'.`,
        'VALIDATION_INVALID_LIMIT',
      );
    }

    const value = Number.parseInt(raw, 10);
    if (value < 1 || value > MAX_LEDGER_LIMIT) {
      throw new WalletRequestValidationError(
        `"limit" must be between 1 and ${MAX_LEDGER_LIMIT}, got ${value}.`,
        'VALIDATION_INVALID_LIMIT',
      );
    }

    return value;
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
