import { describe, expect, it, mock } from 'bun:test';
import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { DomainExceptionFilter, isDomainError } from './index';

class FakeDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'FakeDomainError';
  }
}

function buildHost() {
  const json = mock((_body: unknown) => undefined);
  const status = mock((_code: number) => ({ json }));
  const response = { status, json };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('isDomainError', () => {
  it('is true for an Error with a string code', () => {
    expect(isDomainError(new FakeDomainError('SOME_CODE', 'oops'))).toBe(true);
  });

  it('is false for a plain Error', () => {
    expect(isDomainError(new Error('oops'))).toBe(false);
  });

  it('is false for a non-error value', () => {
    expect(isDomainError({ code: 'SOME_CODE' })).toBe(false);
  });
});

describe('DomainExceptionFilter', () => {
  const filter = new DomainExceptionFilter();

  it('maps a VALIDATION_* code to 400', () => {
    const { host, status, json } = buildHost();
    filter.catch(new FakeDomainError('VALIDATION_EMPTY_AMOUNT', 'Amount must not be empty.'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'VALIDATION_EMPTY_AMOUNT', message: 'Amount must not be empty.' },
    });
  });

  it('maps WALLET_ALREADY_EXISTS to 409', () => {
    const { host, status, json } = buildHost();
    filter.catch(new FakeDomainError('WALLET_ALREADY_EXISTS', 'Wallet already exists.'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'WALLET_ALREADY_EXISTS', message: 'Wallet already exists.' },
    });
  });

  it('maps CURRENCY_MISMATCH to 422', () => {
    const { host, status, json } = buildHost();
    filter.catch(new FakeDomainError('CURRENCY_MISMATCH', 'Currency mismatch.'), host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'CURRENCY_MISMATCH', message: 'Currency mismatch.' },
    });
  });

  it('maps an unknown domain error code to 500', () => {
    const { host, status, json } = buildHost();
    filter.catch(new FakeDomainError('SOMETHING_UNMAPPED', 'Unmapped.'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'SOMETHING_UNMAPPED', message: 'Unmapped.' },
    });
  });

  it('lets a NestJS HttpException keep its own status and response body', () => {
    const { host, status, json } = buildHost();
    filter.catch(new NotFoundException('Route not found.'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      message: 'Route not found.',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('falls back to a generic 500 for a non-domain, non-HttpException error', () => {
    const { host, status, json } = buildHost();
    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' },
    });
  });
});
