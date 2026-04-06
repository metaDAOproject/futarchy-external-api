import type pg from 'pg';

/**
 * Minimal interface for database modules to access the current pool.
 * Uses getters so reconnect-created pools are always current.
 */
export interface DbRuntime {
  getPool(): pg.Pool | null;
  isConnected(): boolean;
}
