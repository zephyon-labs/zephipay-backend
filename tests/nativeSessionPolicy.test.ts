import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import type { RouteClass } from "../src/nativeSession/contracts";
import { NativeCredentialPolicy } from "../src/nativeSession/policy";
import {
  CLIENT,
  fixture,
  SERVICE,
  START,
  SyntheticAuthentication,
  WEB,
} from "./helpers/nativeSessionHarness";

const attacks: [string, Record<string, unknown>][] = [
  ["wrong issuer", { issuer: "https://other.invalid/" }],
  ["unknown client", { azp: "other-client" }],
  ["missing client", { azp: undefined }],
  ["conflicting client dialect", { client_id: "other-client" }],
  ["matching second client dialect still unsupported", { client_id: CLIENT.clientId }],
  ["legacy-only audience", { audience: [WEB.audience] }],
  ["native plus legacy audience", { audience: [CLIENT.audience, WEB.audience] }],
  ["duplicate audience", { audience: [CLIENT.audience, CLIENT.audience] }],
  ["missing account scope", { scopes: ["openid", "native:session"] }],
  ["missing session scope", { scopes: ["openid", "read:account"] }],
  ["unapproved scope", { scopes: [...CLIENT.scopes, "write:payments"] }],
  ["caller-declared class", { credentialClass: "legacy-web" }],
  ["delegation", { act: { sub: "other" } }],
  ["unexpected organization", { org_id: "org" }],
  ["machine principal", { subject: "machine@clients" }],
  ["machine grant", { grant: "client_credentials" }],
  ["implicit grant", { grant: "implicit" }],
  ["bootstrap on refresh", { grant: "refresh_token" }],
  ["token lifetime exceeds policy", { expiresAt: START + 300_001 }],
  ["future issue", { issuedAt: START + 1 }],
  ["invalid time", { issuedAt: NaN }],
  [
    "invalid bootstrap version",
    {
      bootstrap: {
        version: 2,
        loginAttemptId: `attempt_${"01".repeat(16)}`,
        challenge: "33".repeat(32),
      },
    },
  ],
];
for (const [label, changes] of attacks)
  test(`native admission rejects ${label}`, async () => {
    const f = fixture();
    const r = await f.complete(f.auth.issue(f.claims(changes)));
    assert.equal(r.kind, "rejected", JSON.stringify(r));
    assert.equal(f.memory.snapshot().events.length, 0);
  });

test("policy owns credential class even when a native client is configured for a legacy audience", async () => {
  const f = fixture(),
    policy = new NativeCredentialPolicy(f.auth, [
      {
        ...CLIENT,
        audience: WEB.audience,
        scopes: ["read:account", "read:payments", "native:session"],
      },
    ]);
  const c = f.claims({
    audience: [WEB.audience],
    scopes: ["read:account", "read:payments", "native:session"],
  });
  delete (c as Record<string, unknown>).bootstrap;
  const principal = await policy.inspect(f.auth.issue(c));
  assert.ok(principal);
  for (const route of ["legacy-account", "legacy-payment", "service"] as const)
    assert.equal(policy.authorize(principal, route, START)?.code, "ACCESS_DENIED");
  assert.equal(policy.authorize(principal, "native-account", START), null);
});

test("Web and service credentials retain distinct route classes without native privileges", async () => {
  const f = fixture();
  for (const p of [WEB, SERVICE]) {
    const c = f.claims({
      azp: p.clientId,
      audience: [p.audience],
      scopes: [...p.scopes],
      grant: p === SERVICE ? "client_credentials" : "authorization_code",
    });
    delete (c as Record<string, unknown>).bootstrap;
    const principal = await f.policy.inspect(f.auth.issue(c));
    assert.ok(principal);
    assert.equal(
      f.policy.authorize(principal, p === SERVICE ? "service" : "legacy-account", START),
      null,
    );
    assert.equal(f.policy.authorize(principal, "native-account", START)?.code, "ACCESS_DENIED");
    assert.equal(
      f.policy.authorize(principal, p === SERVICE ? "legacy-payment" : "service", START)?.code,
      "ACCESS_DENIED",
    );
  }
});

test("unknown routes and copied/cross-policy principals fail closed", async () => {
  const f = fixture();
  const principal = await f.policy.inspect(f.evidence);
  assert.ok(principal);
  assert.equal(
    f.policy.authorize(principal, "toString" as RouteClass, START)?.code,
    "ACCESS_DENIED",
  );
  assert.equal(
    f.policy.authorize({ ...principal }, "native-account", START)?.code,
    "ACCESS_DENIED",
  );
  const other = new NativeCredentialPolicy(f.auth, [CLIENT]);
  assert.equal(other.authorize(principal, "native-account", START)?.code, "ACCESS_DENIED");
});

test("policy snapshots prevent post-construction caller changes and reject ambiguous registries", async () => {
  const f = fixture();
  const settings = { ...CLIENT, scopes: [...CLIENT.scopes] };
  const policy = new NativeCredentialPolicy(f.auth, [settings]);
  settings.clientId = "attacker";
  settings.credentialClass = "legacy-web";
  settings.scopes.push("write:payments");
  const principal = await policy.inspect(f.evidence);
  assert.ok(principal);
  assert.equal(principal.policy.clientId, CLIENT.clientId);
  assert.equal(principal.policy.credentialClass, "native-user");
  assert.ok(!principal.policy.scopes.includes("write:payments"));
  assert.throws(
    () =>
      new NativeCredentialPolicy(f.auth, [
        CLIENT,
        { ...CLIENT, audience: WEB.audience, credentialClass: "legacy-web" },
      ]),
    /Ambiguous/,
  );
});

test("evidence must come from the configured adapter; raw and copied handles are rejected", async () => {
  const f = fixture();
  assert.equal(await f.policy.inspect(f.claims()), null);
  assert.equal(await f.policy.inspect({ ...f.evidence }), null);
  const other = new SyntheticAuthentication();
  assert.equal(await f.policy.inspect(other.issue(f.claims())), null);
  assert.ok(await f.policy.inspect(f.evidence));
});

test("claim snapshots reject accessors and arrays with dynamic fields", async () => {
  const f = fixture();
  let reads = 0;
  const c = {
    ...f.claims(),
    get subject() {
      reads++;
      return "alice";
    },
  };
  assert.equal(await f.policy.inspect(f.auth.issue(c)), null);
  assert.equal(reads, 0);
  const scopes = [...CLIENT.scopes];
  Object.defineProperty(scopes, "0", {
    get() {
      reads++;
      return "openid";
    },
  });
  assert.equal(await f.policy.inspect(f.auth.issue(f.claims({ scopes }))), null);
  assert.equal(reads, 0);
  const claims = f.claims();
  const principal = await f.policy.inspect(f.auth.issue(claims));
  assert.ok(principal);
  claims.subject = "bob";
  claims.scopes.length = 0;
  assert.equal(principal.authentication.subject, "alice");
  assert.equal(f.policy.authorize(principal, "native-account", START), null);
});

test("same issuer/client in the wrong binding environment is denied", async () => {
  const f = fixture();
  const { NativeSessionCore } = await import("../src/nativeSession/core");
  const core = new NativeSessionCore(
    f.memory,
    new NativeCredentialPolicy(f.auth, [{ ...CLIENT, environment: "other" }]),
    86_400_000,
  );
  const r = await core.complete({
    loginAttemptId: f.b.loginAttemptId,
    evidence: f.evidence,
    accessSecret: "11".repeat(32),
  });
  assert.deepEqual(r, { kind: "rejected", code: "ACCESS_DENIED" });
  assert.equal(f.memory.snapshot().events.length, 0);
});

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [path.join(directory, entry.name)]
        : [],
  );
}
function imports(source: string): string[] {
  const result: string[] = [];
  const tree = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      result.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]))
        result.push(node.arguments[0].text);
      else result.push("<computed-module>");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return result;
}
test("offline core has no production importers, test evidence issuers or infrastructure dependencies", () => {
  const root = path.resolve("src/nativeSession");
  for (const file of files("src")) {
    const source = readFileSync(file, "utf8"),
      native = path.resolve(file).startsWith(root + path.sep);
    const dependencies = imports(source);
    if (native) {
      assert.ok(
        dependencies.every(
          (dep) =>
            dep === "node:crypto" ||
            (dep === "node:util" &&
              ["records.ts", "postgresPersistence.ts"].includes(path.basename(file))) ||
            (path.basename(file) === "postgresPersistence.ts" &&
              ["pg", "../storage/postgres/postgresIdentityPersistence"].includes(dep)) ||
            (dep.startsWith("./") &&
              path.resolve(path.dirname(file), dep).startsWith(root + path.sep)),
        ),
        file,
      );
      assert.ok(!/SyntheticAuthentication|nativeSessionHarness|\bfetch\s*\(/.test(source), file);
    } else {
      assert.ok(
        !dependencies.some(
          (dep) =>
            /nativeSession|nativeSessionHarness/.test(dep) ||
            (dep.startsWith(".") &&
              path.resolve(path.dirname(file), dep).startsWith(root + path.sep)),
        ),
        file,
      );
    }
  }
});
test("isolation scanner negative controls cover static, export and literal dynamic imports", () => {
  for (const source of [
    'import { x } from "./nativeSession/core"',
    'export * from "./nativeSession/core"',
    'require("./nativeSession/core")',
    'import("./nativeSession/core")',
  ])
    assert.deepEqual(imports(source), ["./nativeSession/core"]);
  assert.deepEqual(imports("import(variable)"), ["<computed-module>"]);
});
