/** Explicit profile selection shared by preparation, suite and every recovery process. */
import type { InspectionOrigin } from "./nativePostgresDiagnostics";
import type { Pool } from "pg";
import {
  nativeDisposableTarget as localTarget,
  verifyNativeDisposable as localVerify,
  type DisposableTarget,
} from "./nativePostgresSafety";
import {
  CI_PROFILE,
  ciDisposableTarget,
  isCiTarget,
  verifyCiDisposable,
} from "./nativePostgresCiSafety";

export function nativeDisposableTarget(
  env: Record<string, string | undefined>,
  origin: InspectionOrigin = "INITIAL",
): DisposableTarget {
  if (env.NATIVE_SESSION_TEST_PROFILE === undefined) return localTarget(env);
  if (env.NATIVE_SESSION_TEST_PROFILE === CI_PROFILE)
    return ciDisposableTarget(env, undefined, origin);
  throw new Error("Unknown native PostgreSQL safety profile");
}
export async function verifyNativeDisposable(
  pool: Pick<Pool, "query">,
  target: DisposableTarget,
  empty: boolean,
): Promise<void> {
  if (isCiTarget(target)) return verifyCiDisposable(pool, target, empty);
  return localVerify(pool, target, empty);
}
