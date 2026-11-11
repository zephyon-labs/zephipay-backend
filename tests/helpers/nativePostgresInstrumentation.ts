/** Test-only lease ownership. Never imported by production or the native adapter. */
import type { Pool, PoolClient } from "pg";
import { types } from "node:util";

export type NativePostgresHook = (
  sql: string,
  client: PoolClient,
  result?: unknown,
) => Promise<void>;
function termination(error: unknown): boolean {
  if (!error || typeof error !== "object" || types.isProxy(error)) return false;
  const code = Object.getOwnPropertyDescriptor(error, "code");
  const message = Object.getOwnPropertyDescriptor(error, "message");
  if ((code && !("value" in code)) || (message && !("value" in message)))
    return false;
  return (
    ["57P01", "ECONNRESET", "EPIPE"].includes(code?.value) ||
    (code === undefined &&
      message?.value === "Connection terminated unexpectedly")
  );
}

export function instrumentNativePool(
  pool: Pick<Pool, "query" | "connect">,
  beforeQuery?: NativePostgresHook,
  afterQuery?: NativePostgresHook,
) {
  const pids: number[] = [];
  const leases: {
    pid?: number;
    released: boolean;
    expected: boolean;
    release: () => void;
  }[] = [];
  const retiring: Promise<void>[] = [];
  let unexpected = false;
  const source = {
    query: pool.query.bind(pool),
    connect: async () => {
      const client = await pool.connect();
      let errored = false;
      const lease = {
        pid: undefined as number | undefined,
        released: false,
        expected: false,
        release: () => release(true),
      };
      const onError = (error: unknown) => {
        errored = true;
        if (!lease.expected || !termination(error)) unexpected = true;
      };
      // Install before the PID probe or any hook. The pool's idle listener is absent
      // while leased. Do not remove or replace listeners owned by other callers.
      client.on("error", onError);
      leases.push(lease);
      function release(destroy = false) {
        if (lease.released)
          throw new Error("Instrumented lease released twice");
        lease.released = true;
        if (!destroy && !errored && !lease.expected) {
          client.removeListener("error", onError);
          try {
            client.release();
          } catch {
            unexpected = true;
            throw new Error("Instrumented release failed");
          }
          return;
        }
        // Retain ownership through end, including error events after query rejection
        // or release request. Releasing first would reattach the pool's idle listener.
        const retired = Promise.resolve()
          .then(() => client.end())
          .then(() => {
            client.removeListener("error", onError);
            client.release(true);
          })
          .catch(() => {
            unexpected = true;
          });
        retiring.push(retired);
      }
      const check = () => {
        if (lease.released || errored)
          throw new Error("Instrumented lease unavailable");
      };
      try {
        const result = await client.query("SELECT pg_backend_pid() AS pid");
        check();
        lease.pid = Number(result.rows[0].pid);
        if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0)
          throw new Error("Invalid fixture PID");
        pids.push(lease.pid);
        return {
          query: async (sql: string, values?: unknown[]) => {
            // Preserve the adapter's rollback attempt even after a client error.
            if (sql !== "ROLLBACK") check();
            else if (lease.released)
              throw new Error("Instrumented lease unavailable");
            await beforeQuery?.(sql, client);
            if (sql !== "ROLLBACK") check();
            const result = await client.query(sql, values);
            await afterQuery?.(sql, client, result);
            check();
            return result;
          },
          release,
        } as unknown as PoolClient;
      } catch (error) {
        release(true);
        throw error;
      }
    },
  } as Pick<Pool, "query" | "connect">;
  return {
    source,
    pids,
    expectTermination(pid: number) {
      const matches = leases.filter((l) => l.pid === pid && !l.released);
      if (matches.length !== 1 || matches[0].expected)
        throw new Error("Invalid termination target");
      matches[0].expected = true;
    },
    async settle() {
      for (const lease of leases) {
        if (!lease.released) {
          unexpected = true;
          lease.release();
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(retiring),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Instrumented cleanup incomplete")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (unexpected)
        throw new Error(
          "Unexpected instrumented connection error or cleanup failure",
        );
    },
  };
}
