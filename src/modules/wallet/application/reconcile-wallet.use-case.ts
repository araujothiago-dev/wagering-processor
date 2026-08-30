// `wallet/application` — ReconcileWalletUseCase (Story 4.2).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter. Strictly a read: never corrects the
// wallet's stored balance, only reports whether it matches the ledger.
import { WalletNotFoundError } from '../domain/errors';
import { reconcileWalletBalance, type ReconciliationResult } from '../domain/reconciliation';
import type { WalletLedgerRepository, WalletRepository } from './ports';

export interface ReconcileWalletQuery {
  walletId: string;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly ledgerRepository: WalletLedgerRepository,
  ) {}

  async execute(query: ReconcileWalletQuery): Promise<ReconciliationResult> {
    const wallet = await this.walletRepository.findById(query.walletId);

    if (!wallet) {
      throw new WalletNotFoundError(query.walletId);
    }

    const entries = await this.ledgerRepository.listAll(query.walletId, wallet.currency);

    return reconcileWalletBalance(wallet.balance, entries);
  }
}
