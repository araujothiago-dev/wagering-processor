// `wallet/infrastructure` — WalletTypeOrmRepository (Story 1.3).
//
// Read-only adapter for `WalletRepository` (ports.ts): maps a `WalletEntity` row back into
// `Wallet.rehydrate`. This is the only place `WalletEntity` is read back into a `Wallet` — write
// paths (`CreateWalletTransactionalWriterImpl`) never read before inserting.
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Money } from '../../../shared/money';
import type { WalletRepository } from '../application/ports';
import { Wallet } from '../domain/wallet';
import { WalletEntity } from './wallet.entity';

@Injectable()
export class WalletTypeOrmRepository implements WalletRepository {
  constructor(
    @InjectRepository(WalletEntity)
    private readonly repository: Repository<WalletEntity>,
  ) {}

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.repository.findOneBy({ id });

    if (!row) {
      return null;
    }

    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.of(row.balanceAmount, row.currency),
      version: row.version,
    });
  }
}
