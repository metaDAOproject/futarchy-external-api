import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { AppError } from './errorHandler.js';
import { parseCidrs, ipInAllowlist } from '../utils/ipMatch.js';
import { timingSafeStringEqual } from '../utils/timingSafe.js';

declare global {
  namespace Express {
    interface Request {
      clientTier?: 'anon' | 'trusted';
      apiKey?: string;
      isExempt?: boolean;
    }
  }
}

function findTrustedApiKey(apiKey: string): string | undefined {
  for (const trustedKey of config.server.trustedApiKeys) {
    if (timingSafeStringEqual(apiKey, trustedKey)) {
      return trustedKey;
    }
  }

  return undefined;
}

export function clientContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
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

  req.isExempt = ipInAllowlist(req.ip, parseCidrs(config.server.restriction.exemptCidrs));
  next();
}
