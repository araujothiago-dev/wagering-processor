# Distributed Wagering Processor

Serviço financeiro distribuído (NestJS + TypeORM + PostgreSQL + Bun) que
processa apostas de múltiplos provedores, com foco em correção financeira,
concorrência entre instâncias e idempotência persistente.

Este é o entregável do desafio técnico da Jungle Gaming. O brief original
está preservado em [`docs/CHALLENGE.md`](docs/CHALLENGE.md); as decisões de
arquitetura, o que foi implementado e o que ficou de fora estão em
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — a seção **"Estado da
entrega e limitações conhecidas"** no final desse arquivo é o resumo mais
honesto do que rodar aqui e o que não.

## Stack

Bun 1.3.14 · TypeScript (strict) · NestJS 11 · TypeORM · PostgreSQL 18 ·
SQS via [MiniStack](https://github.com/ministackorg/ministack) · Docker
Compose.

## Subir o stack completo (Docker)

```sh
docker compose up -d
```

Sobe Postgres, o emulador de SQS, roda as migrations automaticamente
(serviço `migrate`, one-shot, roda até completar antes da API aceitar
tráfego) e inicia a API em `http://localhost:3000`.

**Porta 5432**: o compose bina `5432:5432` direto, sem override. Se você já
tem um Postgres local (serviço nativo, outro container) ouvindo nessa
porta, pare-o antes ou o Postgres do compose falha ao subir.

Para derrubar:

```sh
docker compose down       # mantém o volume (dados persistem)
docker compose down -v    # remove o volume também (estado limpo)
```

## Rodar localmente sem Docker (Bun direto)

```sh
bun install
cp .env.example .env               # ajuste se sua instância Postgres não usa os defaults
docker compose up -d postgres sqs  # só a infra, sem a API
bun run migration:run
bun run start:dev
```

## Testes

```sh
bun test                # suíte unitária — não toca Postgres/SQS reais, roda sempre
bun run test:integration  # suíte de integração — Postgres real, HTTP concorrente real
```

A suíte de integração (`src/**/*.integration.ts`) exige a infraestrutura
real de pé e as migrations aplicadas:

```sh
docker compose up -d postgres
cp .env.example .env      # primeira vez só
bun run migration:run
bun run test:integration
```

Ela nunca roda como parte de um `bun test` comum — o nome do arquivo
(`.integration.ts`, não `.spec.ts`/`.test.ts`) fica fora da descoberta
padrão do Bun de propósito.

Outros comandos úteis:

```sh
bun run build       # tsc -p tsconfig.json — type-check completo, emite para dist/ (usado por `bun run start`)
bun run lint         # eslint
bun run lint:fix
bun run format       # prettier
```

## Endpoints principais

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/wallets` | Cria wallet (saldo inicial opcional) |
| `GET` | `/wallets/:walletId` | Consulta wallet |
| `GET` | `/wallets/:walletId/ledger` | Extrato paginado (keyset) |
| `POST` | `/wallets/:walletId/reconciliation` | Reconcilia saldo materializado vs. soma do ledger (nunca corrige, só reporta) |
| `POST` | `/wagering/transactions` | Submete uma operação de aposta (`kind`: `BET`, `WIN` ou `LOSS`; requer header `Idempotency-Key`) |
| `GET` | `/wagering/transactions/:transactionId` | Consulta transação por id |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta transação por referência externa do provedor |
| `GET` | `/health/live`, `/health/ready` | Health checks (sem autenticação) |

`BET` debita o saldo; `WIN` credita (aceita opcionalmente `referenceExternalTransactionId`
apontando pra `BET` da mesma rodada); `LOSS` só registra o resultado, sem tocar saldo/ledger.
`REFUND`/`ROLLBACK` ainda não são aceitos (fora do escopo implementado até aqui).

Exemplo de submissão de uma BET (o mesmo formato vale para `WIN`/`LOSS`, trocando `kind`):

```sh
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: <uuid-ou-string-única>" \
  -d '{
    "providerId": "provider-1",
    "externalTransactionId": "ext-1",
    "playerId": "player-1",
    "walletId": "<uuid-da-wallet>",
    "roundId": "round-1",
    "gameId": "game-1",
    "kind": "BET",
    "amount": "25.00",
    "currency": "USD"
  }'
```

## Estrutura

Hexagonal/DDD por módulo (`domain/application/infrastructure/interface`),
sem `domain`/`application` importando NestJS ou TypeORM diretamente. Módulos:
`wallet`, `wagering`, `health`, mais `shared/` (Money, HTTP/erros de domínio)
transversal. Detalhes em `docs/ARCHITECTURE.md`.
