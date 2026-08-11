import { Pool, type PoolConfig } from "pg";

import { instrumentPostgresPool } from "../../observability/reliabilityObservability";

// Runtime-only bounds. Migrations retain their separate max=1 pool. Usage-based
// retirement avoids synchronized wall-clock expiry; server-side timeouts cancel
// database work while preserving atomic rollback behavior.
export const PAYMENT_POSTGRES_POOL_CONFIG = Object.freeze({
  max: 10,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  maxUses: 5_000,
  statement_timeout: 30_000,
  lock_timeout: 15_000,
  idle_in_transaction_session_timeout: 15_000,
} satisfies PoolConfig);

export function createPaymentPostgresPool(databaseUrl: string): Pool {
  const config: PoolConfig = {
    connectionString: databaseUrl,
    ...PAYMENT_POSTGRES_POOL_CONFIG,
  };

  return instrumentPostgresPool(new Pool(config));
}
