// `wagering/application` — GetWagerTransactionUseCase (Story 2.4).
//
// Rule (AD-2): this layer only imports `domain` plus the ports it declares itself — never
// NestJS, TypeORM, or any concrete infrastructure adapter. Strictly a read: no lock, no
// balance/ledger effect.
import { TransactionNotFoundError } from '../domain/errors';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { WagerTransactionRepository } from './ports';

export class GetWagerTransactionUseCase {
  constructor(private readonly repository: WagerTransactionRepository) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.repository.findById(transactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(`No transaction found with id '${transactionId}'.`);
    }

    return transaction;
  }

  async byProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.repository.findByProviderAndExternalId(providerId, externalTransactionId);

    if (!transaction) {
      throw new TransactionNotFoundError(
        `No transaction found for provider '${providerId}' and externalTransactionId '${externalTransactionId}'.`,
      );
    }

    return transaction;
  }
}
