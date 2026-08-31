// `wagering` module wiring (Story 2.1, widened Story 2.2). `SubmitBetUseCase`/
// `SubmitWinLossUseCase` stay plain classes (AD-2: the application layer never imports NestJS)
// so they can't carry their own `@Injectable()` — each is wired here via a factory provider
// keyed on the class itself, same pattern as `wallet.module.ts`. Both share the one
// `SubmitWagerTransactionalWriterImpl` instance — same lock+savepoint+idempotency mechanics
// regardless of kind.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessageEntity } from '../wallet/infrastructure/outbox-message.entity';
import { WagerTransactionEntity } from '../wallet/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../wallet/infrastructure/wallet-ledger-entry.entity';
import { WalletEntity } from '../wallet/infrastructure/wallet.entity';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { SubmitBetUseCase } from './application/submit-bet.use-case';
import { SubmitWinLossUseCase } from './application/submit-win-loss.use-case';
import { SubmitWagerTransactionalWriterImpl } from './infrastructure/submit-wager-transaction.transactional-writer';
import { WagerTransactionTypeOrmRepository } from './infrastructure/wager-transaction.typeorm-repository';
import { WageringController } from './interface/wagering.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, OutboxMessageEntity]),
  ],
  controllers: [WageringController],
  providers: [
    SubmitWagerTransactionalWriterImpl,
    WagerTransactionTypeOrmRepository,
    {
      provide: SubmitBetUseCase,
      useFactory: (writer: SubmitWagerTransactionalWriterImpl) => new SubmitBetUseCase(writer),
      inject: [SubmitWagerTransactionalWriterImpl],
    },
    {
      provide: SubmitWinLossUseCase,
      useFactory: (writer: SubmitWagerTransactionalWriterImpl, repository: WagerTransactionTypeOrmRepository) =>
        new SubmitWinLossUseCase(writer, repository),
      inject: [SubmitWagerTransactionalWriterImpl, WagerTransactionTypeOrmRepository],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (repository: WagerTransactionTypeOrmRepository) => new GetWagerTransactionUseCase(repository),
      inject: [WagerTransactionTypeOrmRepository],
    },
  ],
})
export class WageringModule {}
