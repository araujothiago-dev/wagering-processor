// `wallet` module wiring (Story 1.2). `CreateWalletUseCase` stays a plain class (AD-2: the
// application layer never imports NestJS) so it can't carry its own `@Injectable()` — it's wired
// here via a factory provider keyed on the class itself, which Nest resolves through
// `WalletController`'s constructor-parameter type the same way as any other provider.
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { GetWalletLedgerUseCase } from './application/get-wallet-ledger.use-case';
import { GetWalletUseCase } from './application/get-wallet.use-case';
import { CreateWalletTransactionalWriterImpl } from './infrastructure/create-wallet.transactional-writer';
import { OutboxMessageEntity } from './infrastructure/outbox-message.entity';
import { WagerTransactionEntity } from './infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from './infrastructure/wallet-ledger-entry.entity';
import { WalletLedgerTypeOrmRepository } from './infrastructure/wallet-ledger.typeorm-repository';
import { WalletEntity } from './infrastructure/wallet.entity';
import { WalletTypeOrmRepository } from './infrastructure/wallet.typeorm-repository';
import { WalletController } from './interface/wallet.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      OutboxMessageEntity,
    ]),
  ],
  controllers: [WalletController],
  providers: [
    CreateWalletTransactionalWriterImpl,
    WalletTypeOrmRepository,
    WalletLedgerTypeOrmRepository,
    {
      provide: CreateWalletUseCase,
      useFactory: (writer: CreateWalletTransactionalWriterImpl) => new CreateWalletUseCase(writer),
      inject: [CreateWalletTransactionalWriterImpl],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (walletRepository: WalletTypeOrmRepository) => new GetWalletUseCase(walletRepository),
      inject: [WalletTypeOrmRepository],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (
        walletRepository: WalletTypeOrmRepository,
        ledgerRepository: WalletLedgerTypeOrmRepository,
      ) => new GetWalletLedgerUseCase(walletRepository, ledgerRepository),
      inject: [WalletTypeOrmRepository, WalletLedgerTypeOrmRepository],
    },
  ],
})
export class WalletModule {}
