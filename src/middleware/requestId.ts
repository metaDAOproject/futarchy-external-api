import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // A client-supplied id is echoed in a response header and written to logs,
  // so only accept short, plain tokens; anything else gets a fresh UUID.
  const supplied = req.headers['x-request-id'];
  const requestId = typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
