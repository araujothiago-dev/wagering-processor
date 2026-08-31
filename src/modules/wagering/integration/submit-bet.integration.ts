// `wagering/integration` — SubmitBet concurrency suite (Story 2.1, README §13/§14 "falha
// eliminatória: testes que substituem completamente PostgreSQL... por mocks").
//
// Real PostgreSQL, a real Nest application (the actual `AppModule`, not a stub), real HTTP
// requests via `fetch` fired genuinely in parallel with `Promise.all` — never sequential mocks.
// Covers the 3 concurrency scenarios this story automates (spec matrix, Design Notes — the 4th,
// >= 3 process instances, is a documented manual procedure, not automated here):
//   1. two BETs racing to exceed the same wallet's balance;
//   2. the same BET (key + payload) sent 50x in parallel;
//   3. two different wallets processed concurrently, no cross-wallet blocking.
//
// Prerequisite (never runs as part of `bun test`, only `bun run test:integration`):
//   docker-compose up -d postgres
//   cp .env.example .env   # first time only; DB_HOST=localhost matches the compose port mapping
//   bun run migration:run
//   bun run test:integration
//
// The filename itself (`.integration.ts`, not `.spec.ts`/`.test.ts`) is what keeps this suite out
// of the default `bun test` run — bun's default file discovery only ever considers
// `*.test.ts`/`*.spec.ts` (and their `_test_`/`_spec_` variants), so a bare `bun test` never even
// looks at this file. `test:integration` (package.json) instead points bun at this file directly
// via a glob resolved by bun's own cross-platform script shell (`bun test ./src/**/*.integration.ts`)
// — bun only treats an argument as a file path, bypassing that naming-convention filter, when it
// is (or resolves to) an actual path starting with `./`.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { AppModule } from '../../../app.module';

let app: INestApplication;
let baseUrl: string;

interface CreatedWallet {
  id: string;
  playerId: string;
}

interface SubmitBetParams {
  walletId: string;
  playerId: string;
  amount: string;
  externalTransactionId: string;
  idempotencyKey: string;
  currency?: string;
  providerId?: string;
  roundId?: string;
  gameId?: string;
  // Story 2.2 — defaults to 'BET' so every pre-existing call site (Story 2.1's concurrency suite
  // below) is unaffected.
  kind?: 'BET' | 'WIN' | 'LOSS';
  referenceExternalTransactionId?: string;
}

interface SubmitBetResponseBody {
  transactionId: string;
  status: string;
  balance: string;
  currency: string;
  idempotentReplay: boolean;
  error?: { code: string; message: string };
}

async function createWallet(initialBalance: string, currency = 'BRL'): Promise<CreatedWallet> {
  const playerId = randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, currency, initialBalance }),
  });

  if (response.status !== 201) {
    throw new Error(`Failed to create wallet: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

async function submitBet(params: SubmitBetParams): Promise<{ status: number; body: SubmitBetResponseBody }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': params.idempotencyKey },
    body: JSON.stringify({
      providerId: params.providerId ?? 'provider-a',
      externalTransactionId: params.externalTransactionId,
      playerId: params.playerId,
      walletId: params.walletId,
      roundId: params.roundId ?? 'round-1',
      gameId: params.gameId ?? 'fortune-chimp',
      kind: params.kind ?? 'BET',
      amount: params.amount,
      currency: params.currency ?? 'BRL',
      ...(params.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: params.referenceExternalTransactionId }
        : {}),
    }),
  });

  const body = (await response.json()) as SubmitBetResponseBody;
  return { status: response.status, body };
}

async function getWallet(walletId: string): Promise<{ balance: string; version: number }> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}`);
  return (await response.json()) as { balance: string; version: number };
}

async function getLedgerEntries(walletId: string): Promise<Array<{ direction: string; money: string }>> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger?limit=100`);
  const body = (await response.json()) as { entries: Array<{ direction: string; money: string }> };
  return body.entries;
}

async function getLedgerDebits(walletId: string): Promise<Array<{ money: string }>> {
  return (await getLedgerEntries(walletId)).filter((entry) => entry.direction === 'DEBIT');
}

async function getLedgerCredits(walletId: string): Promise<Array<{ money: string }>> {
  return (await getLedgerEntries(walletId)).filter((entry) => entry.direction === 'CREDIT');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);

  const address = app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await app.close();
});

describe('SubmitBet — concurrency (real Postgres, real HTTP, real parallelism)', () => {
  describe('scenario 1 — two BETs racing to exceed the wallet balance', () => {
    it('processes exactly one and rejects the other, with a single ledger debit and the correct final balance', async () => {
      const wallet = await createWallet('100.00');
      const keyA = `provider-a:${randomUUID()}`;
      const keyB = `provider-a:${randomUUID()}`;

      const [first, second] = await Promise.all([
        submitBet({
          walletId: wallet.id,
          playerId: wallet.playerId,
          amount: '80.00',
          externalTransactionId: keyA,
          idempotencyKey: keyA,
        }),
        submitBet({
          walletId: wallet.id,
          playerId: wallet.playerId,
          amount: '80.00',
          externalTransactionId: keyB,
          idempotencyKey: keyB,
        }),
      ]);

      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 422]);

      const finalWallet = await getWallet(wallet.id);
      expect(finalWallet.balance).toBe('20.00');

      const debits = await getLedgerDebits(wallet.id);
      expect(debits).toHaveLength(1);
      expect(debits[0]?.money).toBe('80.00');
    }, 30_000);
  });

  describe('scenario 2 — the same BET (key + payload) sent 50x in parallel', () => {
    it('applies exactly one debit; the other 49 requests replay the same terminal result', async () => {
      const wallet = await createWallet('1000.00');
      const idempotencyKey = `provider-a:${randomUUID()}`;
      const request: SubmitBetParams = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '10.00',
        externalTransactionId: idempotencyKey,
        idempotencyKey,
      };

      const results = await Promise.all(Array.from({ length: 50 }, () => submitBet(request)));

      for (const result of results) {
        expect(result.status).toBe(200);
      }

      const transactionIds = new Set(results.map((result) => result.body.transactionId));
      expect(transactionIds.size).toBe(1);

      const freshCount = results.filter((result) => result.body.idempotentReplay === false).length;
      const replayCount = results.filter((result) => result.body.idempotentReplay === true).length;
      expect(freshCount).toBe(1);
      expect(replayCount).toBe(49);

      // Every response — fresh or replayed — must agree on the same frozen balance.
      const balances = new Set(results.map((result) => result.body.balance));
      expect(balances.size).toBe(1);
      expect(balances.has('990.00')).toBe(true);

      const finalWallet = await getWallet(wallet.id);
      expect(finalWallet.balance).toBe('990.00');

      const debits = await getLedgerDebits(wallet.id);
      expect(debits).toHaveLength(1);
    }, 60_000);
  });

  describe('scenario 3 — two different wallets processed concurrently', () => {
    it('processes both correctly with no cross-wallet blocking', async () => {
      const [walletA, walletB] = await Promise.all([createWallet('100.00'), createWallet('100.00')]);

      const [resultA, resultB] = await Promise.all([
        submitBet({
          walletId: walletA.id,
          playerId: walletA.playerId,
          amount: '50.00',
          externalTransactionId: `tx-a-${randomUUID()}`,
          idempotencyKey: `provider-a:${randomUUID()}`,
        }),
        submitBet({
          walletId: walletB.id,
          playerId: walletB.playerId,
          amount: '50.00',
          externalTransactionId: `tx-b-${randomUUID()}`,
          idempotencyKey: `provider-a:${randomUUID()}`,
        }),
      ]);

      expect(resultA.status).toBe(200);
      expect(resultB.status).toBe(200);

      const [finalA, finalB] = await Promise.all([getWallet(walletA.id), getWallet(walletB.id)]);
      expect(finalA.balance).toBe('50.00');
      expect(finalB.balance).toBe('50.00');
    }, 30_000);
  });
});

// Story 2.2 — WIN/LOSS against real Postgres (README §13 "atomicidade real"): a WIN's credit and
// its exactly-one ledger CREDIT, LOSS's total no-op, and both kinds' idempotent replay reusing
// Story 2.1's mechanism unmodified.
describe('SubmitBet — WIN and LOSS (real Postgres, real HTTP)', () => {
  describe('WIN', () => {
    it('credits the wallet and writes exactly one CREDIT ledger entry, with or without a valid reference', async () => {
      const wallet = await createWallet('100.00');
      const betExternalId = `bet-${randomUUID()}`;

      const bet = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '30.00',
        externalTransactionId: betExternalId,
        idempotencyKey: `provider-a:${betExternalId}`,
        kind: 'BET',
      });
      expect(bet.status).toBe(200);

      const winNoRef = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '15.00',
        externalTransactionId: `win-no-ref-${randomUUID()}`,
        idempotencyKey: `provider-a:win-no-ref-${randomUUID()}`,
        kind: 'WIN',
      });
      expect(winNoRef.status).toBe(200);
      expect(winNoRef.body.status).toBe('PROCESSED');
      expect(winNoRef.body.balance).toBe('85.00');

      const winWithRefKey = `provider-a:win-with-ref-${randomUUID()}`;
      const winWithRef = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '20.00',
        externalTransactionId: `win-with-ref-${randomUUID()}`,
        idempotencyKey: winWithRefKey,
        kind: 'WIN',
        referenceExternalTransactionId: betExternalId,
      });
      expect(winWithRef.status).toBe(200);
      expect(winWithRef.body.balance).toBe('105.00');

      const finalWallet = await getWallet(wallet.id);
      expect(finalWallet.balance).toBe('105.00');

      const credits = await getLedgerCredits(wallet.id);
      expect(credits).toHaveLength(2);
      expect(credits.map((c) => c.money).sort()).toEqual(['15.00', '20.00']);

      const debits = await getLedgerDebits(wallet.id);
      expect(debits).toHaveLength(1);
      expect(debits[0]?.money).toBe('30.00');
    }, 30_000);

    it('rejects with 422 REFERENCE_SCOPE_MISMATCH when the reference belongs to another wallet', async () => {
      const [walletA, walletB] = await Promise.all([createWallet('100.00'), createWallet('100.00')]);
      const betExternalId = `bet-${randomUUID()}`;

      const bet = await submitBet({
        walletId: walletA.id,
        playerId: walletA.playerId,
        amount: '30.00',
        externalTransactionId: betExternalId,
        idempotencyKey: `provider-a:${betExternalId}`,
        kind: 'BET',
      });
      expect(bet.status).toBe(200);

      const win = await submitBet({
        walletId: walletB.id,
        playerId: walletB.playerId,
        amount: '10.00',
        externalTransactionId: `win-${randomUUID()}`,
        idempotencyKey: `provider-a:win-${randomUUID()}`,
        kind: 'WIN',
        referenceExternalTransactionId: betExternalId,
      });

      expect(win.status).toBe(422);
      expect(win.body.error?.code).toBe('REFERENCE_SCOPE_MISMATCH');

      const finalB = await getWallet(walletB.id);
      expect(finalB.balance).toBe('100.00');
      expect(await getLedgerCredits(walletB.id)).toHaveLength(0);
    }, 30_000);

    it('rejects with 422 REFERENCE_NOT_FOUND when the reference was never submitted', async () => {
      const wallet = await createWallet('100.00');

      const win = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '10.00',
        externalTransactionId: `win-${randomUUID()}`,
        idempotencyKey: `provider-a:win-${randomUUID()}`,
        kind: 'WIN',
        referenceExternalTransactionId: `never-submitted-${randomUUID()}`,
      });

      expect(win.status).toBe(422);
      expect(win.body.error?.code).toBe('REFERENCE_NOT_FOUND');

      const finalWallet = await getWallet(wallet.id);
      expect(finalWallet.balance).toBe('100.00');
    }, 30_000);

    it('replays idempotently: same key + payload resent returns the same frozen balance with idempotentReplay=true', async () => {
      const wallet = await createWallet('100.00');
      const idempotencyKey = `provider-a:win-${randomUUID()}`;
      const request: SubmitBetParams = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '25.00',
        externalTransactionId: idempotencyKey,
        idempotencyKey,
        kind: 'WIN',
      };

      const first = await submitBet(request);
      const second = await submitBet(request);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.idempotentReplay).toBe(false);
      expect(second.body.idempotentReplay).toBe(true);
      expect(second.body.transactionId).toBe(first.body.transactionId);
      expect(second.body.balance).toBe(first.body.balance);
      expect(second.body.balance).toBe('125.00');

      const credits = await getLedgerCredits(wallet.id);
      expect(credits).toHaveLength(1);
    }, 30_000);
  });

  describe('LOSS', () => {
    it('leaves the balance unchanged and writes no ledger entry', async () => {
      const wallet = await createWallet('100.00');

      const loss = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '40.00',
        externalTransactionId: `loss-${randomUUID()}`,
        idempotencyKey: `provider-a:loss-${randomUUID()}`,
        kind: 'LOSS',
      });

      expect(loss.status).toBe(200);
      expect(loss.body.status).toBe('PROCESSED');
      expect(loss.body.balance).toBe('100.00');

      const finalWallet = await getWallet(wallet.id);
      expect(finalWallet.balance).toBe('100.00');
      expect(await getLedgerEntries(wallet.id)).toHaveLength(0);
    }, 30_000);

    it('replays idempotently: same key + payload resent returns the same terminal result with idempotentReplay=true', async () => {
      const wallet = await createWallet('100.00');
      const idempotencyKey = `provider-a:loss-${randomUUID()}`;
      const request: SubmitBetParams = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '40.00',
        externalTransactionId: idempotencyKey,
        idempotencyKey,
        kind: 'LOSS',
      };

      const first = await submitBet(request);
      const second = await submitBet(request);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.idempotentReplay).toBe(false);
      expect(second.body.idempotentReplay).toBe(true);
      expect(second.body.transactionId).toBe(first.body.transactionId);
      expect(second.body.balance).toBe('100.00');

      const finalWallet = await getWallet(wallet.id);
      expect(finalWallet.balance).toBe('100.00');
      expect(await getLedgerEntries(wallet.id)).toHaveLength(0);
    }, 30_000);

    it('returns 409 IDEMPOTENCY_KEY_CONFLICT when the same key is resent with a different payload', async () => {
      const wallet = await createWallet('100.00');
      const idempotencyKey = `provider-a:loss-${randomUUID()}`;

      const first = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '40.00',
        externalTransactionId: `loss-${randomUUID()}`,
        idempotencyKey,
        kind: 'LOSS',
      });
      expect(first.status).toBe(200);

      const second = await submitBet({
        walletId: wallet.id,
        playerId: wallet.playerId,
        amount: '55.00',
        externalTransactionId: `loss-${randomUUID()}`,
        idempotencyKey,
        kind: 'LOSS',
      });

      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    }, 30_000);
  });
});
