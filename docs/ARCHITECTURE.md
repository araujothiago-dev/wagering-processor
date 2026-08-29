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

## Topologia local
`docker-compose.yml`: `api`, `postgres:18`, MiniStack (SQS), com migração
one-shot rodando antes da API aceitar tráfego. Sem exigir conta/token
externo para subir localmente.

## Escopo cortado por decisão (documentar, não implementar)
Autenticação real (Keycloak/Zitadel), double-entry bookkeeping,
OpenTelemetry/dashboards, teste de carga, CQRS/event sourcing completo,
frontend.
