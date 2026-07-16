export type ErrorCode =
  | 'bad_request'
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'plan_rejected'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  plan_rejected: 400,
  internal: 500,
};

/**
 * The single error type crossing every boundary (HTTP, MCP, jobs). The wire
 * shape is stable API: { error: { code, message, details? } }.
 */
export class ApickError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApickError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details ?? null;
  }

  toBody(): { error: { code: ErrorCode; message: string; details: unknown } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }

  static wrap(err: unknown): ApickError {
    if (err instanceof ApickError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new ApickError('internal', message);
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) => new ApickError('bad_request', message, details),
  validation: (message: string, details?: unknown) => new ApickError('validation', message, details),
  unauthorized: (message = 'Authentication required') => new ApickError('unauthorized', message),
  forbidden: (message = 'Not allowed') => new ApickError('forbidden', message),
  notFound: (message = 'Not found') => new ApickError('not_found', message),
  conflict: (message: string, details?: unknown) => new ApickError('conflict', message, details),
  planRejected: (message: string, details?: unknown) => new ApickError('plan_rejected', message, details),
  internal: (message: string) => new ApickError('internal', message),
};
