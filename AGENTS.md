# AGENTS.md - Futarchy CoinGecko API

## Quick Start Commands (BUN ONLY)

**Use `bun` for EVERYTHING. Never use `npm`, `pnpm`, or `yarn`.**

### Core Commands
- **`bun install`** - Install dependencies
- **`bun run dev`** - Start development server with watch mode
- **`bun run build`** - Compile TypeScript to dist/
- **`bun run start`** - Run compiled server (runs build first via prestart)
- **`bun test`** - Run all tests
- **`bun run <script>`** - Run any script from package.json

### Data Serving
- Market data and ticker volume are served from the external user_pool ETL DB.
- This API does not run local backfills, Dune fetchers, or indexer workers.

## Project Structure

```
src/
├── main.ts             # API entry point (server startup, graceful shutdown)
├── app.ts              # Express app setup & middleware (rate limit, metrics, CORS)
├── config.ts           # Configuration & environment variables
├── runtime/            # Service composition + background heartbeat
├── routes/             # Route handlers (tickers, market, supply, dexscreener, health)
├── services/           # Business logic & data access
│   ├── externalDatabaseService.ts   # Served ETL DB — the ONLY database
│   └── [other services]
├── middleware/         # errorHandler (AppError/asyncHandler), requestId
├── types/              # TypeScript type definitions
└── utils/              # Logger, alerts, validation, scheduling, resilience
```

## Key Technologies

- **Runtime**: Bun (native TypeScript)
- **Framework**: Express.js
- **Database**: PostgreSQL (pg driver)
- **Blockchain**: Solana Web3.js, Anchor Framework
- **Monitoring**: Prometheus (prom-client)
- **Testing**: Bun's native test runner

## Development Workflow

1. **Start dev server**: `bun run dev`
2. **Make code changes** in src/
3. **TypeScript errors** will show in terminal
4. **Run tests**: `bun test`
5. **Build for production**: `bun run build`

## Environment Setup

1. Copy `example.env` to `.env`
2. Configure PostgreSQL connection and API keys
3. Configure `FRONTEND_READER_PG_URL` or `EXTERNAL_DATABASE_URL` for served ETL reads

## Important Notes

- **Package Manager**: This project uses Bun exclusively. Do NOT run `npm install`, `npm run`, `pnpm`, or `yarn`.
- **TypeScript**: Target is ESNext, compiled to dist/ via `bun run build`
- **Main files**:
  - `src/main.ts` - Server startup (entry point)
  - `tsconfig.json` - Compiler config
- **Lock file**: `bun.lock` - commit this, not node_modules
- **Serving invariant**: infrastructure failures (RPC/DB) must surface as 5xx —
  never as 200 with zero/empty/total-as-circulating data. Do not add catch
  blocks that convert unknown errors into default values in financial paths.

## Testing

- Tests run via Bun's native test runner
- Test files go in `tests/` directory
- Run with: `bun test`

## Building & Deployment

1. **Development**: `bun run dev` (with file watching)
2. **Production build**: `bun run build` → outputs to `dist/`
3. **Production start**: `bun run start` (runs build first via prestart script)

## Database

- Uses PostgreSQL with pg driver
- ONE database: the read-only served ETL DB, configured via `.env`
  (`FRONTEND_READER_PG_URL` or `EXTERNAL_DATABASE_URL`)
- The legacy app DB (`COINGECKO_PG_URL`/`DATABASE_URL`) is REMOVED — do not
  reintroduce it; if a write is ever needed it goes to the prod DB
- No local backfill scripts or Dune fetchers run in this API

## Common Issues

| Issue | Solution |
|-------|----------|
| Dependencies missing | `bun install` |
| TypeScript errors | `bun run typecheck` to see full errors |
| Tests fail | `bun test` to run suite |
| ENV vars missing | Copy example.env to .env and fill values |

## Related Files

- `README.md` - Project overview and public API documentation
- `docs/tickers-volume-cutover-validation.md` - Serving contract for ticker volume
