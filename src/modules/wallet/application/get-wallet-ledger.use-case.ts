// `wallet/application` — GetWalletLedgerUseCase (Story 1.3).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter. Strictly a read: never touches
// balance/ledger, never `read → check → insert`.
//
// Wallet existence is checked here, before delegating to `WalletLedgerRepository` — an empty
// page is ambiguous (a real wallet with no entries yet vs. no wallet at all), so this use case
// never infers 404 from an empty result, it asks `WalletRepository` directly. A malformed
// `cursor` is never decoded here either: it's passed through opaque, and `LedgerCursorError`
// raised by the port's concrete adapter propagates untouched (spec "propagação de erro de
// cursor vindo da porta").
import { WalletNotFoundError } from '../domain/errors';
import type { ListWalletLedgerResult, WalletLedgerRepository, WalletRepository } from './ports';

const MIN_LEDGER_LIMIT = 1;
const MAX_LEDGER_LIMIT = 100;

// Defense-in-depth, not a replacement for `WalletController.parseLimit`: this use case is a
// plain class any caller can construct directly (a future CLI, a script, a different
// interface), so the `[1,100]` range is enforced here too rather than trusted from the
// controller alone. `code` mirrors the controller's own `VALIDATION_INVALID_LIMIT` so both
// paths map to the same HTTP status through `DomainExceptionFilter`.
export class GetWalletLedgerLimitError extends Error {
  readonly code = 'VALIDATION_INVALID_LIMIT' as const;

  constructor(limit: number) {
    super(`"limit" must be an integer between ${MIN_LEDGER_LIMIT} and ${MAX_LEDGER_LIMIT}, got ${limit}.`);
    this.name = 'GetWalletLedgerLimitError';
  }
}

export interface GetWalletLedgerQuery {
  walletId: string;
  limit: number;
  cursor?: string;
}

export class GetWalletLedgerUseCase {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly ledgerRepository: WalletLedgerRepository,
  ) {}

  async execute(query: GetWalletLedgerQuery): Promise<ListWalletLedgerResult> {
    this.assertValidLimit(query.limit);

    const wallet = await this.walletRepository.findById(query.walletId);

    if (!wallet) {
      throw new WalletNotFoundError(query.walletId);
    }

    // Two sequential round-trips (wallet, then entries) rather than a currency-aware join —
    // deliberate: it keeps `WalletRepository`/`WalletLedgerRepository` independent ports with no
    // knowledge of each other, and this story states no latency requirement that would justify
    // the extra coupling.
    return this.ledgerRepository.list({
      walletId: query.walletId,
      currency: wallet.currency,
      limit: query.limit,
      cursor: query.cursor,
    });
  }

  private assertValidLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < MIN_LEDGER_LIMIT || limit > MAX_LEDGER_LIMIT) {
      throw new GetWalletLedgerLimitError(limit);
    }
  }
}
