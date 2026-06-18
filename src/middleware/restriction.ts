import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { metricsService } from '../services/metricsService.js';

const RETRY_AFTER_SECONDS = 60;

function matchesPathPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => prefix.length > 0 && path.startsWith(prefix));
}

function sendRestricted(req: Request, res: Response, reason: string): void {
  metricsService.recordRestrictionRejection(reason);
  res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
  res.status(503).json({
    error: 'Service temporarily restricted',
    code: 'SERVICE_RESTRICTED',
    requestId: req.requestId,
  });
}

export function restrictionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (matchesPathPrefix(req.path, config.server.restriction.alwaysAllowedPaths)) {
    next();
    return;
  }

  if (matchesPathPrefix(req.path, config.server.restriction.disabledPaths)) {
    sendRestricted(req, res, 'disabled_path');
    return;
  }

  if (req.isExempt) {
    next();
    return;
  }

  switch (config.server.restriction.mode) {
    case 'normal':
      next();
      return;
    case 'restricted':
      if (req.clientTier === 'trusted') {
        next();
        return;
      }
      sendRestricted(req, res, 'restricted_anon');
      return;
    case 'lockdown':
      if (req.clientTier === 'trusted') {
        next();
        return;
      }
      sendRestricted(req, res, 'lockdown_anon');
      return;
    default:
      next();
      return;
  }
}
