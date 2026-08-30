// `wallet/infrastructure` — opaque keyset cursor codec (Story 1.3, spec "Design Notes").
//
// Cursor = `base64url(JSON.stringify({walletId, createdAt, id}))` of the last entry of a page.
// `WalletLedgerTypeOrmRepository` compares the `(createdAt, id)` half against `(created_at, id)`
// in SQL for stable pagination under concurrent inserts — `id` (a UUID) breaks ties when
// `createdAt` collides at millisecond resolution. Never OFFSET (spec "Boundaries &
// Constraints"). `walletId` isn't part of that SQL comparison — it's a binding check: a
// syntactically valid cursor issued for one wallet's ledger must never be silently accepted by
// another wallet's `.../ledger` call (wrong page, no error). The repository verifies
// `cursor.walletId === params.walletId` right after decoding and rejects a mismatch the same way
// as an undecodable cursor.
//
// `LedgerCursorError` is raised only here (never by the controller, which treats the cursor as
// an opaque string) and propagates untouched through `GetWalletLedgerUseCase` up to
// `DomainExceptionFilter`, whose `code.startsWith('VALIDATION_')` branch already covers it.
export class LedgerCursorError extends Error {
  readonly code = 'VALIDATION_INVALID_CURSOR' as const;

  constructor(message: string) {
    super(message);
    this.name = 'LedgerCursorError';
  }
}

export interface LedgerCursor {
  walletId: string;
  createdAt: string;
  id: string;
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(raw: string): LedgerCursor {
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new LedgerCursorError(`Cursor '${raw}' is not valid base64url.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new LedgerCursorError(`Cursor '${raw}' does not decode to valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new LedgerCursorError(`Cursor '${raw}' does not decode to a JSON object.`);
  }

  const { walletId, createdAt, id } = parsed as Record<string, unknown>;

  if (typeof walletId !== 'string' || typeof createdAt !== 'string' || typeof id !== 'string') {
    throw new LedgerCursorError(
      `Cursor '${raw}' must decode to a {walletId, createdAt, id} shape of strings.`,
    );
  }

  if (Number.isNaN(Date.parse(createdAt))) {
    throw new LedgerCursorError(`Cursor '${raw}' has an invalid 'createdAt' timestamp.`);
  }

  return { walletId, createdAt, id };
}
