import type { PublicKeyInput } from "express-oauth2-jwt-bearer";
import type { MockRailScenario } from "zephyon-protocol";

export type LocalHarnessAuth = Readonly<{ publicKey: PublicKeyInput; mockScenario?: MockRailScenario }>;

let configured: LocalHarnessAuth | undefined;

/** Constructor-only local harness seam. There is deliberately no environment or HTTP control. */
export function configureLocalHarnessAuth(value: LocalHarnessAuth): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Local harness authentication requires NODE_ENV=test.");
  if (configured) throw new Error("Local harness authentication is already configured.");
  configured = Object.freeze({ publicKey: value.publicKey, ...(value.mockScenario ? { mockScenario: value.mockScenario } : {}) });
}

export function localHarnessAuth(): LocalHarnessAuth | undefined {
  return configured;
}

export function resetLocalHarnessAuthForTest(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Local harness authentication reset requires NODE_ENV=test.");
  configured = undefined;
}
