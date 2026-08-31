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
}

interface SubmitBetResponseBody {
  transactionId: string;
  status: string;
  balance: string;
  currency: string;
  idempotentReplay: boolean;
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
      kind: 'BET',
      amount: params.amount,
      currency: params.currency ?? 'BRL',
    }),
  });

  const body = (await response.json()) as SubmitBetResponseBody;
  return { status: response.status, body };
}

async function getWallet(walletId: string): Promise<{ balance: string; version: number }> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}`);
  return (await response.json()) as { balance: string; version: number };
}

async function getLedgerDebits(walletId: string): Promise<Array<{ money: string }>> {
  const response = await fetch(`${baseUrl}/wallets/${walletId}/ledger?limit=100`);
  const body = (await response.json()) as { entries: Array<{ direction: string; money: string }> };
  return body.entries.filter((entry) => entry.direction === 'DEBIT');
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
