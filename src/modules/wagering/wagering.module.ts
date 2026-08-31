// `wagering` module wiring (Story 2.1). `SubmitBetUseCase` stays a plain class (AD-2: the
// application layer never imports NestJS) so it can't carry its own `@Injectable()` — it's wired
// here via a factory provider keyed on the class itself, same pattern as `wallet.module.ts`.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxMessageEntity } from '../wallet/infrastructure/outbox-message.entity';
import { WagerTransactionEntity } from '../wallet/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../wallet/infrastructure/wallet-ledger-entry.entity';
import { WalletEntity } from '../wallet/infrastructure/wallet.entity';
import { GetWagerTransactionUseCase } from './application/get-wager-transaction.use-case';
import { SubmitBetUseCase } from './application/submit-bet.use-case';
import { SubmitBetTransactionalWriterImpl } from './infrastructure/submit-bet.transactional-writer';
import { WagerTransactionTypeOrmRepository } from './infrastructure/wager-transaction.typeorm-repository';
import { WageringController } from './interface/wagering.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, OutboxMessageEntity]),
  ],
  controllers: [WageringController],
  providers: [
    SubmitBetTransactionalWriterImpl,
    WagerTransactionTypeOrmRepository,
    {
      provide: SubmitBetUseCase,
      useFactory: (writer: SubmitBetTransactionalWriterImpl, transactionRepository: WagerTransactionTypeOrmRepository) =>
        new SubmitBetUseCase(writer, transactionRepository),
      inject: [SubmitBetTransactionalWriterImpl, WagerTransactionTypeOrmRepository],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (repository: WagerTransactionTypeOrmRepository) => new GetWagerTransactionUseCase(repository),
      inject: [WagerTransactionTypeOrmRepository],
    },
  ],
})
export class WageringModule {}
