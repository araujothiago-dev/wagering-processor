// `wallet/application` — GetWalletUseCase (Story 1.3).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter. Strictly a read: never touches
// balance/ledger, never `read → check → insert`.
import { WalletNotFoundError } from '../domain/errors';
import type { Wallet } from '../domain/wallet';
import type { WalletRepository } from './ports';

export interface GetWalletQuery {
  walletId: string;
}

export class GetWalletUseCase {
  constructor(private readonly walletRepository: WalletRepository) {}

  async execute(query: GetWalletQuery): Promise<Wallet> {
    const wallet = await this.walletRepository.findById(query.walletId);

    if (!wallet) {
      throw new WalletNotFoundError(query.walletId);
    }

    return wallet;
  }
}
