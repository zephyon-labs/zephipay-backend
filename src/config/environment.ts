function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`Expected boolean environment value, received: ${value}`);
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function parsePositiveDecimal(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) {
    return [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function parseDatabaseUrl(
  enabled: boolean,
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();

  if (!enabled && !normalized) {
    return undefined;
  }

  if (!normalized) {
    throw new Error("DATABASE_URL is required when POSTGRES_ENABLED=true.");
  }

  let parsed: URL;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol.");
  }

  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("DATABASE_URL must include a host and database name.");
  }

  return normalized;
}

const nodeEnv = process.env.NODE_ENV?.trim() || "development";
const isProduction = nodeEnv === "production";

const corsAllowedOrigins = parseOrigins(
  process.env.CORS_ALLOWED_ORIGINS,
);

const postgresEnabled = parseBoolean(
  process.env.POSTGRES_ENABLED,
  false,
);

const databaseUrl = parseDatabaseUrl(
  postgresEnabled,
  process.env.DATABASE_URL,
);

const authEnabled = parseBoolean(process.env.AUTH_ENABLED, false);
const syntheticBetaIdentitiesRequested = parseBoolean(process.env.SYNTHETIC_BETA_IDENTITIES_ENABLED, false);
const growthProjectionEnabled = parseBoolean(
  process.env.GROWTH_PROJECTION_ENABLED,
  false,
);
const zpProjectionEnabled = parseBoolean(
  process.env.ZP_PROJECTION_ENABLED,
  false,
);
const x402Enabled = parseBoolean(
  process.env.X402_ENABLED,
  false,
);
const x402SvmAddress = process.env.SVM_ADDRESS?.trim() || undefined;
const auth0Issuer = process.env.AUTH0_ISSUER?.trim();
const auth0Audience = process.env.AUTH0_AUDIENCE?.trim();
const auth0RequiredScope = process.env.AUTH0_REQUIRED_SCOPE?.trim() || "read:account";
const auth0WriteAccountScope = process.env.AUTH0_WRITE_ACCOUNT_SCOPE?.trim() || "write:account";
const auth0ReadPaymentsScope = process.env.AUTH0_READ_PAYMENTS_SCOPE?.trim() || "read:payments";
const auth0WritePaymentsScope = process.env.AUTH0_WRITE_PAYMENTS_SCOPE?.trim() || "write:payments";

if (authEnabled && (!auth0Issuer || !auth0Audience || !postgresEnabled)) {
  throw new Error("AUTH0_ISSUER, AUTH0_AUDIENCE, and POSTGRES_ENABLED=true are required when AUTH_ENABLED=true.");
}
if (syntheticBetaIdentitiesRequested && (!authEnabled || !postgresEnabled || parseBoolean(process.env.PAYMENTS_ENABLED,false))) {
  throw new Error("SYNTHETIC_BETA_IDENTITIES_ENABLED requires authenticated PostgreSQL Mock-only execution with PAYMENTS_ENABLED=false.");
}
if ((growthProjectionEnabled || zpProjectionEnabled) && !postgresEnabled) {
  throw new Error(
    "Growth/ZP projection requires POSTGRES_ENABLED=true.",
  );
}
if (x402Enabled && !x402SvmAddress) {
  throw new Error("SVM_ADDRESS is required when X402_ENABLED=true.");
}
if (auth0Issuer) {
  const issuerUrl = new URL(auth0Issuer);
  if (issuerUrl.protocol !== "https:" || !auth0Issuer.endsWith("/")) {
    throw new Error("AUTH0_ISSUER must be an HTTPS URL with a trailing slash.");
  }
}

if (isProduction && !process.env.CORS_ALLOWED_ORIGINS) {
  throw new Error(
    "CORS_ALLOWED_ORIGINS is required when NODE_ENV=production.",
  );
}

export const environment = Object.freeze({
  nodeEnv,
  isProduction,

  port: parsePositiveInteger(
    process.env.PORT,
    3001,
    "PORT",
  ),

  paymentsEnabled: parseBoolean(
    process.env.PAYMENTS_ENABLED,
    false,
  ),
  syntheticBetaIdentitiesEnabled: syntheticBetaIdentitiesRequested,
  growthProjectionEnabled,
  zpProjectionEnabled,
  x402Enabled,
  x402SvmAddress,

  postgresEnabled,
  databaseUrl,

  authEnabled,
  auth0Issuer,
  auth0Audience,
  auth0RequiredScope,
  auth0WriteAccountScope,
  auth0ReadPaymentsScope,
  auth0WritePaymentsScope,

  trustProxy: parseBoolean(
    process.env.TRUST_PROXY,
    isProduction,
  ),

  corsAllowedOrigins,

  jsonBodyLimit: process.env.JSON_BODY_LIMIT?.trim() || "16kb",

  paymentRateLimitPerMinute: parsePositiveInteger(
    process.env.PAYMENT_RATE_LIMIT_PER_MINUTE,
    5,
    "PAYMENT_RATE_LIMIT_PER_MINUTE",
  ),

  authenticatedReadRateLimitPerMinute: parsePositiveInteger(
    process.env.AUTHENTICATED_READ_RATE_LIMIT_PER_MINUTE,
    120,
    "AUTHENTICATED_READ_RATE_LIMIT_PER_MINUTE",
  ),

  paymentMaxUsdc: parsePositiveDecimal(
    process.env.PAYMENT_MAX_USDC,
    5,
    "PAYMENT_MAX_USDC",
  ),
});
