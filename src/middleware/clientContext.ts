import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { AppError } from './errorHandler.js';
import { timingSafeStringEqual } from '../utils/timingSafe.js';

declare global {
  namespace Express {
    interface Request {
      clientTier?: 'anon' | 'trusted';
      apiKey?: string;
    }
  }
}

function findTrustedApiKey(apiKey: string): string | undefined {
  // Iterate every key without early-exit: returning on first match would leak
  // the matching key's position via how many comparisons ran, undermining the
  // constant-time intent of timingSafeStringEqual.
  let matched: string | undefined;
  for (const trustedKey of config.server.trustedApiKeys) {
    if (timingSafeStringEqual(apiKey, trustedKey)) {
      matched = trustedKey;
    }
  }

  return matched;
}

export function createClientContextMiddleware() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const apiKey = req.header('x-api-key');

    if (apiKey) {
      const trustedKey = findTrustedApiKey(apiKey);
      if (!trustedKey) {
        throw AppError.unauthorized('Invalid API key', 'INVALID_API_KEY');
      }

      req.clientTier = 'trusted';
      req.apiKey = trustedKey;
    } else {
      req.clientTier = 'anon';
    }

    next();
  };
}
