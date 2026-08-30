# ARCHITECTURE.md (reconstrução de emergência — máquina original temporariamente inacessível)

> Este documento foi reconstruído a partir do histórico de decisões discutidas
> e aprovadas em sessão de planejamento (BMad), não é uma cópia literal do
> `ARCHITECTURE-SPINE.md` original. Cobre as decisões técnicas necessárias
> para continuar a implementação. Reconciliar com o arquivo original
> (`_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md`)
> assim que a máquina original voltar a ficar acessível — em caso de
> divergência, o arquivo original é a fonte da verdade.

## Paradigma
Hexagonal + DDD. Direção de dependência estrita: `domain/` nunca importa
NestJS, TypeORM ou SDK de infraestrutura (AWS SDK, etc.). Módulos
`wallet` e `wagering`, cada um com `domain/application/infrastructure/interface`,
mais `shared/` e `health/` transversais.

## Stack (pinada no lockfile)
- Bun 1.3.14 (corrigido de uma versão flutuante inicial no Dockerfile)
- TypeScript 6.0, modo strict
- NestJS ^11.1
- TypeORM ^1.1 + @nestjs/typeorm (trocado de MikroORM 7.1 por familiaridade da
  equipe + prazo de 2 dias — decisão revisada, não a escolha original do
  fast path)
- decimal.js ^10.6
- PostgreSQL 18
- MiniStack (SQS) em vez de LocalStack

## Money e persistência
`Money` imutável (amount decimal string + currency), nunca `number`/`float`.
Persistido como `NUMERIC(20,2)` via `ValueTransformer` do TypeORM que
converte para/de `decimal.js` na borda com o banco.

## Concorrência — lock pessimista por wallet (não otimista por version)
Unidade de concorrência = `walletId`. Implementação:
```
queryRunner.manager.findOne(Wallet, {
  where: { id },
  lock: { mode: 'pessimistic_write' }
})
```
dentro de `queryRunner.startTransaction()` explícito (`FOR UPDATE`, sem
`NOWAIT`/`SKIP LOCKED` — bloqueante, não rejeita concorrentes, apenas espera).
`version` na Wallet existe como contador de auditoria/ETag (FR19), **não**
é o mecanismo de lock.

> Implicação para observabilidade: como o lock é bloqueante, não existe
> evento discreto de "conflito rejeitado" para contar — a métrica de
> "conflitos de lock" deve medir **tempo de espera pelo lock** (lock wait
> duration), não uma contagem de conflitos. Isso não muda o comportamento
> bloqueante da Story 2.1. **Ponto pendente de confirmação**: a AC final
> da Story 4.1 com essa correção não foi reconfirmada por completo nesta
> reconstrução — verificar o texto exato ao reconciliar.

## Idempotência
`UNIQUE(idempotency_key)` em `wager_transactions` + insert especulativo
protegido por `SAVEPOINT` **nomeado manualmente via SQL cru**
(`queryRunner.query('SAVEPOINT nome')` / `ROLLBACK TO SAVEPOINT nome`) —
deliberadamente **não** o savepoint automático de transação aninhada do
TypeORM (`startTransaction()` aninhado), por histórico de bugs de savepoint
aninhado dependendo do driver. Isso é o ponto mais crítico de correção
financeira do idempotency path — não simplificar de volta para o savepoint
automático.

Replay (mesma key + mesmo `payloadHash`): retorna o resultado terminal
já registrado, com o `balanceAfter` **congelado daquela transação original**
— nunca o saldo atual da wallet.
Conflito (mesma key + `payloadHash` diferente): `409 IDEMPOTENCY_KEY_CONFLICT`,
nunca replay.

`payloadHash` = hash de JSON canônico (chaves ordenadas) do payload de negócio.

## Ledger
Imutável — sem `UPDATE`/`DELETE` possível no schema (revogar privilégio ou
não expor repositório de update). Todo lançamento valida
`balanceBefore ± money == balanceAfter`.

## Reversões (REFUND / ROLLBACK) — proteção contra dupla reversão
Constraint corrigida (a original com `kind` na chave permitia bug):
```sql
UNIQUE(reference_transaction_id)
  WHERE kind IN ('REFUND', 'ROLLBACK')
  AND status IN ('PROCESSED', 'PENDING_REFERENCE')
```
Sem `kind` no índice — bloqueia REFUND seguido de ROLLBACK (ou o inverso)
na mesma referência enquanto uma está `PROCESSED` ou `PENDING_REFERENCE`.
Excluir `REJECTED`/`FAILED` do predicado permite retry legítimo depois de
um erro de escopo.

Conjuntos de referência **distintos por operação** (validações separadas,
não uma checagem genérica):
- REFUND: só pode referenciar uma **BET**
- ROLLBACK: pode referenciar **BET, WIN ou REFUND**
- Tipo de referência errado → `REFERENCE_WRONG_KIND`
- Referência de tipo certo mas fora de escopo (provider/player/wallet/moeda/rodada
  errado) → `REFERENCE_SCOPE_MISMATCH`
- Reversão que zeraria/negativaria saldo → `REVERSAL_WOULD_GO_NEGATIVE`
  (distinto de `INSUFFICIENT_BALANCE`)

## Referências fora de ordem (PENDING_REFERENCE)
Aceitar e persistir como `PENDING_REFERENCE` é comportamento **síncrono**
do endpoint HTTP (Epic 2) — sem isso, o sistema quebraria ao receber uma
referência fora de ordem mesmo sem SQS. O worker que reprocessa em
background (poll + lease + backoff exponencial) é assíncrono (Epic 3).

Ordem de lock no reprocessamento: **wallet primeiro, depois a linha da
wager_transaction** — mesma ordem do write path normal, para não inverter
e causar deadlock (esse foi um dos 2 bugs reais pegos no gate de revisão
da arquitetura original: deadlock construtível por ordem de lock invertida).

Limite de tentativas/TTL esgotado → `REJECTED` com `failureCode =
REFERENCE_NOT_FOUND_TIMEOUT`, evento `WagerTransactionRejected` gravado
na outbox.

## Outbox transacional
`outbox_messages` (colunas definidas já na migration da Story 1.2, incluindo
`attempts` e `next_attempt_at` — não numa migration posterior) grava na
**mesma transação SQL** que wallet + ledger + wager_transaction (+ inbox,
quando a origem é SQS).

Publisher: worker embutido via `@Cron`/`@Interval` em cada instância (não
processo separado). Reivindica lote via `FOR UPDATE SKIP LOCKED`, publica,
só marca `published_at` após sucesso confirmado do SQS. Se o processo
morre entre claim e publish, o lease (`next_attempt_at`) expira e outra
instância reivindica — duplicata resultante é aceitável (idempotência do
consumer/downstream cobre isso).

## Consumer SQS (inbox + classificação de falha)
`inbox_messages` com `UNIQUE(consumer_name, message_id)` — dedup
persistente, nunca em memória. Reusa o **mesmo use case** do caminho HTTP.
Ack só após commit.

Classificação:
- Erro de negócio (ex. saldo insuficiente) → ack (rejeição já persistida
  como `REJECTED` pelo use case; reentregar só repetiria o mesmo resultado)
- Erro transitório (timeout, deadlock) → sem ack, visibilidade expira para
  reentrega com backoff
- Limite de tentativas esgotado → `wager-transactions-dlq.fifo`

`SIGTERM`: para de puxar novas mensagens, aguarda timeout configurável
para as mensagens em voo concluírem, devolve visibilidade das que não
terminarem — nunca mata com transação aberta.

## Auth
Não implementado. `AuthGuard` no-op documentado como ponto de extensão.

## Schema — invariantes garantidas no banco, não só em código
- `wallets`: `UNIQUE(player_id, currency)`, `CHECK(balance_amount >= 0)`
- `wager_transactions`: `UNIQUE(idempotency_key)`,
  `UNIQUE(reference_transaction_id) WHERE kind IN (...) AND status IN (...)`
  (ver seção de reversões acima)
- `wallet_ledger_entries`: sem UPDATE/DELETE possível
- `inbox_messages`: `UNIQUE(consumer_name, message_id)`
- `outbox_messages`: colunas `attempts`, `next_attempt_at`, `published_at`
  já desde a Story 1.2
- toda coluna de timestamp é `timestamptz`, nunca o `timestamp` (sem timezone) que
  `@CreateDateColumn`/`@Column` do TypeORM mapeiam por padrão quando `type` não é explícito:
  `node-postgres` hidrata uma coluna `timestamp` como `Date` assumindo que o valor naive está no
  timezone **local do processo Node**, não UTC — desloca todo valor lido em processos que não
  rodam em UTC. Achado e corrigido na Story 1.3 (`created_at` das 4 tabelas da Story 1.2 estava
  sem `type` explícito; corrompia a comparação do cursor de paginação do ledger). `timestamptz`
  armazena um instante absoluto, sem essa ambiguidade de leitura.

## Topologia local
`docker-compose.yml`: `api`, `postgres:18`, MiniStack (SQS), com migração
one-shot rodando antes da API aceitar tráfego. Sem exigir conta/token
externo para subir localmente.

## Escopo cortado por decisão (documentar, não implementar)
Autenticação real (Keycloak/Zitadel), double-entry bookkeeping,
OpenTelemetry/dashboards, teste de carga, CQRS/event sourcing completo,
frontend.

## Estado da entrega e limitações conhecidas

### Implementado e verificado contra Postgres real
- **Epic 1 completo** — `Wallet`/`WalletLedgerEntry` (domínio imutável,
  self-validação `balanceBefore ± money == balanceAfter`), criação de wallet
  com saldo inicial (Story 1.2), consulta de wallet e extrato paginado por
  keyset do ledger (Story 1.3). Migration real (não só `synchronize`)
  verificada contra o `CHECK(balance_amount >= 0)` e o revoke de
  `UPDATE`/`DELETE` em `wallet_ledger_entries` rodando com um role não
  superuser.
- **Story 2.1 (submeter BET)** — lock pessimista por `walletId`
  (`pessimistic_write` dentro de transação explícita), idempotência via
  `UNIQUE(idempotency_key)` + insert especulativo protegido por `SAVEPOINT`
  nomeado manualmente (nunca o savepoint automático do TypeORM),
  `payloadHash` sobre o payload de negócio para distinguir replay de
  conflito, outbox transacional (2 eventos no sucesso, 1 na rejeição —
  nunca publicados fora desta story, Epic 3 cobre o publisher). Suíte de
  integração real automatizada (`*.integration.ts`, Postgres real, `AppModule`
  real, HTTP concorrente via `fetch`+`Promise.all`) cobre 3 dos 4 cenários
  de concorrência do spec: duas BETs disputando o mesmo saldo, a mesma BET
  replicada 50x em paralelo, e duas wallets distintas processadas
  concorrentemente sem bloqueio cruzado. O 4º cenário (≥ 3 instâncias de
  processo distintas) é procedimento manual documentado no spec da story,
  não automatizado.
- **Story 2.4 (consultar wager transaction)** — por id e por
  `(providerId, externalTransactionId)`, 404 quando não existe.
- **Story 4.2 (reconciliação)** — `POST /wallets/:walletId/reconciliation`
  soma o ledger inteiro da wallet a partir de `"0.00"` e compara com o
  saldo materializado; nunca corrige, só reporta divergência.

### Não implementado por corte consciente de escopo (prazo)
- **Story 2.2 (WIN/LOSS) e Story 2.3 (REFUND/ROLLBACK)** — desenho e regras
  já completamente especificados no planejamento interno da entrega
  (incluindo a constraint `UNIQUE(reference_transaction_id) WHERE kind IN
  (...) AND status IN (...)` sem `kind` no índice, os dois conjuntos de
  referência distintos por operação, e os códigos `REFERENCE_WRONG_KIND` /
  `REFERENCE_SCOPE_MISMATCH` / `REVERSAL_WOULD_GO_NEGATIVE`). Reusariam o
  mesmo mecanismo de lock pessimista + idempotência da Story 2.1 — a
  decisão foi não codificar sob pressão de tempo para não introduzir um
  bug financeiro não revisado com o mesmo rigor das stories já entregues.
- **Epic 3 inteiro** — consumer SQS (inbox + classificação de falha
  transitória/negócio/DLQ), publisher da outbox (`FOR UPDATE SKIP LOCKED`),
  worker de reprocessamento de referências `PENDING_REFERENCE`. Não
  iniciado; o schema (`outbox_messages`, colunas `attempts`/
  `next_attempt_at`/`published_at`) já existe desde a Story 1.2 para não
  exigir migration adicional quando isso for retomado.
- **Autenticação** — decisão original documentada na seção "Auth" acima:
  `AuthGuard` no-op como ponto de extensão, não vale pontos na avaliação
  (`docs/CHALLENGE.md` §2).
- **Observabilidade** — mínima (`/health/live`, `/health/ready`); sem
  OpenTelemetry, métricas ou dashboards.

### Ordem de implementação se houvesse mais tempo
1. Story 2.2 (WIN/LOSS) e Story 2.3 (REFUND/ROLLBACK) — risco incremental
   baixo sobre a Story 2.1, mesmo mecanismo de lock + idempotência já
   provado.
2. Publisher da outbox + consumer SQS (Epic 3) — sem isso, nenhum evento
   sai do banco, e a entrega segue apenas HTTP síncrono.
3. Worker de reprocessamento de referências `PENDING_REFERENCE` (poll +
   lease + backoff exponencial, ordem de lock wallet-primeiro já definida
   acima).
4. Observabilidade (OpenTelemetry, dashboards, métrica de lock wait
   duration já apontada na seção de concorrência).
