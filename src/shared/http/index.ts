// `shared/http` — domain-error → HTTP boundary (Story 1.2). The única borda that translates a
// domain error into an HTTP response; every other layer just throws.
//
// `DomainError` is a *structural* contract (code + message), not a base class other modules
// extend: `shared/money` and every `modules/*/domain` error class already satisfy it without
// importing anything from here — AD-2/AD-8 forbid `shared/money`/`domain` from ever importing
// NestJS, and this file's filter does exactly that, so the dependency can only point one way.
//
// Status mapping: `VALIDATION_*` → 400, `WALLET_ALREADY_EXISTS` → 409 (spec-1-2). Business-rule
// errors that are neither malformed input nor a conflict get 422 — `CURRENCY_MISMATCH` is the
// only one today; `INSUFFICIENT_BALANCE`/`REVERSAL_WOULD_GO_NEGATIVE` (Epic 2) follow the same
// pattern.
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

export interface DomainError {
  readonly code: string;
  readonly message: string;
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}

function statusForCode(code: string): number {
  if (code.startsWith('VALIDATION_')) {
    return HttpStatus.BAD_REQUEST;
  }

  if (code === 'WALLET_ALREADY_EXISTS') {
    return HttpStatus.CONFLICT;
  }

  if (code === 'CURRENCY_MISMATCH') {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }

  return HttpStatus.INTERNAL_SERVER_ERROR;
}

// Minimal shape instead of importing express's `Response` (not a declared dependency here) —
// works unchanged under the Fastify adapter too, since both expose a chainable status()/json().
interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();

    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }

    if (isDomainError(error)) {
      response.status(statusForCode(error.code)).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected error.' },
    });
  }
}
