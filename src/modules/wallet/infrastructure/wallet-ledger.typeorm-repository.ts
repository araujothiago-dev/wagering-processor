// `wallet/infrastructure` — WalletLedgerTypeOrmRepository (Story 1.3, spec "Design Notes").
//
// Keyset pagination — never OFFSET (spec "Boundaries & Constraints"): `ORDER BY created_at ASC,
// id ASC` plus a `(created_at, id) > (cursor.createdAt, cursor.id)` tuple comparison, stable
// under concurrent inserts even when two entries share a millisecond (the UUID `id` breaks the
// tie). Explicit `::timestamptz`/`::uuid` casts on the bound parameters keep that comparison's
// types unambiguous to any future reader, rather than relying on Postgres to infer them from
// context inside a row-value comparison. Fetches `limit + 1` rows to know whether there's a next
// page without a separate `COUNT` round-trip — the spec's standard trick.
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Money } from '../../../shared/money';
import type {
  ListWalletLedgerParams,
  ListWalletLedgerResult,
  WalletLedgerRepository,
} from '../application/ports';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { decodeLedgerCursor, encodeLedgerCursor, LedgerCursorError } from './ledger-cursor.codec';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';

// Same `code`-carrying shape every other error class in this codebase uses, so
// `DomainExceptionFilter` still produces a structured body if this ever surfaces — even though
// it's not expected to be reachable outside a bug in this file (see `buildNextCursor`).
class LedgerRepositoryInvariantError extends Error {
  readonly code = 'INTERNAL_INVARIANT_VIOLATION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'LedgerRepositoryInvariantError';
  }
}

@Injectable()
export class WalletLedgerTypeOrmRepository implements WalletLedgerRepository {
  constructor(
    @InjectRepository(WalletLedgerEntryEntity)
    private readonly repository: Repository<WalletLedgerEntryEntity>,
  ) {}

  async list(params: ListWalletLedgerParams): Promise<ListWalletLedgerResult> {
    const cursor = this.decodeAndVerifyCursor(params);

    const queryBuilder = this.repository
      .createQueryBuilder('entry')
      .where('entry.walletId = :walletId', { walletId: params.walletId })
      .orderBy('entry.createdAt', 'ASC')
      .addOrderBy('entry.id', 'ASC')
      .take(params.limit + 1);

    if (cursor) {
      queryBuilder.andWhere(
        '(entry.createdAt, entry.id) > ((:cursorCreatedAt)::timestamptz, (:cursorId)::uuid)',
        {
          cursorCreatedAt: cursor.createdAt,
          cursorId: cursor.id,
        },
      );
    }

    const rows = await queryBuilder.getMany();
    const hasNextPage = rows.length > params.limit;
    const page = hasNextPage ? rows.slice(0, params.limit) : rows;
    const entries = page.map((row) => this.toDomain(row, params.currency));

    return {
      entries,
      nextCursor: hasNextPage ? this.buildNextCursor(entries) : undefined,
    };
  }

  // Decoding alone isn't enough: a cursor is only valid for the wallet it was issued for. A
  // syntactically well-formed cursor minted from a different wallet's ledger must be rejected
  // the same way as an undecodable one — never silently accepted against the wrong `walletId`.
  private decodeAndVerifyCursor(params: ListWalletLedgerParams) {
    if (params.cursor === undefined) {
      return undefined;
    }

    const cursor = decodeLedgerCursor(params.cursor);

    if (cursor.walletId !== params.walletId) {
      throw new LedgerCursorError(
        `Cursor was issued for wallet '${cursor.walletId}', not '${params.walletId}'.`,
      );
    }

    return cursor;
  }

  private buildNextCursor(entries: WalletLedgerEntry[]): string {
    const last = entries[entries.length - 1];

    // Unreachable in practice: `hasNextPage` is only true when `rows.length > limit`, which
    // requires at least `limit + 1 >= 1` row, so `page` (and therefore `entries`) is non-empty.
    if (!last) {
      throw new LedgerRepositoryInvariantError('Invariant violation: no entries to build a nextCursor from.');
    }

    return encodeLedgerCursor({ walletId: last.walletId, createdAt: last.createdAt.toISOString(), id: last.id });
  }

  private toDomain(row: WalletLedgerEntryEntity, currency: string): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: row.id,
      walletId: row.walletId,
      wagerTransactionId: row.wagerTransactionId,
      direction: row.direction,
      money: Money.of(row.amount, currency),
      balanceBefore: Money.of(row.balanceBefore, currency),
      balanceAfter: Money.of(row.balanceAfter, currency),
      createdAt: row.createdAt,
    });
  }
}
