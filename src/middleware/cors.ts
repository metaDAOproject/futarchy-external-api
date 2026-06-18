import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('Origin');

  if (config.server.allowedOrigins.length === 0) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && config.server.allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }

  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key');
  next();
}
