import { Router, type Request, type Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import type { ServiceGetters } from './types.js';

export function createLaunchesRouter(services: ServiceGetters): Router {
  const router = Router();
  const { getLaunchpadService, getFutarchyService } = services;

  // Launches currently accepting commitments, read on-chain and cached for
  // CACHE_LIVE_LAUNCHES_TTL (default 5 min). RPC failures surface as 5xx.
  router.get('/api/launches/live', asyncHandler(async (_req: Request, res: Response) => {
    const snapshot = await getLaunchpadService().getLiveLaunches();
    const futarchyService = getFutarchyService();

    // Token name/symbol from Metaplex metadata (cached long-term by
    // FutarchyService). Identification only: null if the metadata is missing.
    const launches = await Promise.all(snapshot.launches.map(async (launch) => {
      const metadata = await futarchyService.getTokenMetadata(new PublicKey(launch.tokenAddress));
      return {
        ...launch,
        tokenName: metadata?.name ?? null,
        tokenSymbol: metadata?.symbol ?? null,
      };
    }));

    res.json({ count: launches.length, updatedAt: snapshot.updatedAt, launches });
  }));

  return router;
}
