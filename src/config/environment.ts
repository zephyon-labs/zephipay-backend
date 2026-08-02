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
const auth0Issuer = process.env.AUTH0_ISSUER?.trim();
const auth0Audience = process.env.AUTH0_AUDIENCE?.trim();
const auth0RequiredScope = process.env.AUTH0_REQUIRED_SCOPE?.trim() || "read:account";

if (authEnabled && (!auth0Issuer || !auth0Audience || !postgresEnabled)) {
  throw new Error("AUTH0_ISSUER, AUTH0_AUDIENCE, and POSTGRES_ENABLED=true are required when AUTH_ENABLED=true.");
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

  postgresEnabled,
  databaseUrl,

  authEnabled,
  auth0Issuer,
  auth0Audience,
  auth0RequiredScope,

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

  paymentMaxUsdc: parsePositiveDecimal(
    process.env.PAYMENT_MAX_USDC,
    5,
    "PAYMENT_MAX_USDC",
  ),
});
