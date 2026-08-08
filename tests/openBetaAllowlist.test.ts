import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  betaAllowlistRequired,
  hasActivePaymentAccess,
} from "../src/allowlist/allowlistEntry";

const original = process.env.BETA_ALLOWLIST_REQUIRED;

afterEach(() => {
  if (original === undefined) {
    delete process.env.BETA_ALLOWLIST_REQUIRED;
  } else {
    process.env.BETA_ALLOWLIST_REQUIRED = original;
  }
});

describe("open beta allowlist policy", () => {
  it("preserves closed-beta enforcement when configuration is absent", () => {
    delete process.env.BETA_ALLOWLIST_REQUIRED;

    assert.equal(betaAllowlistRequired(), true);
    assert.equal(hasActivePaymentAccess(undefined), false);
  });

  it("preserves closed-beta enforcement when explicitly enabled", () => {
    process.env.BETA_ALLOWLIST_REQUIRED = "true";

    assert.equal(betaAllowlistRequired(), true);
    assert.equal(hasActivePaymentAccess(undefined), false);
  });

  it("disables only allowlist enforcement for explicitly configured open beta", () => {
    process.env.BETA_ALLOWLIST_REQUIRED = "false";

    assert.equal(betaAllowlistRequired(), false);
    assert.equal(hasActivePaymentAccess(undefined), true);
  });

  it("fails closed for malformed configuration", () => {
    process.env.BETA_ALLOWLIST_REQUIRED = "definitely";

    assert.equal(betaAllowlistRequired(), true);
    assert.equal(hasActivePaymentAccess(undefined), false);
  });
});
