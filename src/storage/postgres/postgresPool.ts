import { Pool, type PoolConfig } from "pg";

export function createPaymentPostgresPool(databaseUrl: string): Pool {
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };

  return new Pool(config);
}
