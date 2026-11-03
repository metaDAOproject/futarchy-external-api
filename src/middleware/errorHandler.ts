import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code?: string;
  /** The request parameter a 4xx is about, echoed in the response body. */
  public readonly field?: string;

  constructor(
    message: string,
    statusCode: number = 500,
    options?: { code?: string; isOperational?: boolean; field?: string }
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = options?.isOperational ?? true;
    this.code = options?.code;
    this.field = options?.field;
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code?: string, field?: string): AppError {
    return new AppError(message, 400, { code, field });
  }

  static unauthorized(message: string = 'Unauthorized', code?: string): AppError {
    return new AppError(message, 401, { code });
  }

  static notFound(message: string = 'Resource not found', code?: string): AppError {
    return new AppError(message, 404, { code });
  }

  static internal(message: string = 'Internal server error', code?: string): AppError {
    return new AppError(message, 500, { code, isOperational: false });
  }

  static serviceUnavailable(message: string = 'Service unavailable', code?: string): AppError {
    return new AppError(message, 503, { code });
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId || 'unknown';

  // The response already went out (e.g. the request timed out while the
  // handler was still running): log, but don't try to write a second one.
  if (res.headersSent) {
    logger.warn('Error after response was sent', { requestId, path: req.path, error: err.message });
    return;
  }

  if (err instanceof AppError) {
    logger.warn('Operational error', {
      requestId,
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      path: req.path,
      method: req.method,
    });

    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.field ? { field: err.field } : {}),
      requestId,
    });
    return;
  }

  logger.error('Unhandled error', err, {
    requestId,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    requestId,
  });
}

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
