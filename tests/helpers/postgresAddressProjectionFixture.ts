import assert from "node:assert/strict";
import { isIP } from "node:net";

/** Controlled identity-query double, not a SQL engine or live PostgreSQL evidence.
 * PostgreSQL 16 Table 9.40: explicit inet::text retains the netmask; host(inet)
 * returns only the host. Connection-address fixtures represent individual hosts.
 * https://www.postgresql.org/docs/16/functions-net.html#FUNCTIONS-NETWORK
 * Deliberately malformed returned records can bypass this model in negative tests.
 */
export function postgresAddressProjectionFixture(
  sql: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const projected = { ...row };
  for (const [functionName, field] of [
    ["inet_server_addr", "address"],
    ["inet_client_addr", "client_address"],
  ]) {
    if (!sql.includes(`${functionName}()`)) continue;
    if (sql.includes(`host(${functionName}()) AS ${field}`)) continue;
    assert.ok(sql.includes(`${functionName}()::text AS ${field}`));
    const value = row[field];
    // NULL remains NULL. Invalid result injections are never normalized to safety.
    if (typeof value === "string" && isIP(value))
      projected[field] = `${value}/${isIP(value) === 4 ? 32 : 128}`;
  }
  return projected;
}
