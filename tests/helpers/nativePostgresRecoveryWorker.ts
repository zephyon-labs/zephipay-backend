/** Test-only fresh-process recovery probe. No production importer or real authentication. */
import { Pool } from "pg";
import { NativeSessionCore } from "../../src/nativeSession/core";
import { NativeCredentialPolicy } from "../../src/nativeSession/policy";
import { PostgresNativeSessionPersistence } from "../../src/nativeSession/postgresPersistence";
import { ACCESS, CLIENT, SyntheticAuthentication } from "./nativeSessionHarness";
import { nativeDisposableTarget, verifyNativeDisposable } from "./nativePostgresTarget";

async function main() {
  const target = nativeDisposableTarget(process.env),
    pool = new Pool(target.pool);
  try {
    await verifyNativeDisposable(pool, target, false);
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input) as {
      reference: string;
      subject: string;
      action: "complete" | "validate" | "exit-after-commit";
    };
    const { rows } = await pool.query(
      "SELECT login_attempt_id,challenge FROM native_session_candidate.bindings WHERE binding_reference=$1",
      [request.reference],
    );
    if (rows.length !== 1) throw new Error("Unknown fixture binding");
    const now = Number(
      (await pool.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now"))
        .rows[0].now,
    );
    const auth = new SyntheticAuthentication(),
      core = new NativeSessionCore(
        new PostgresNativeSessionPersistence(pool),
        new NativeCredentialPolicy(auth, [CLIENT]),
        86_400_000,
      );
    const completing = request.action !== "validate";
    const evidence = auth.issue({
      issuer: CLIENT.issuer,
      subject: request.subject,
      azp: CLIENT.clientId,
      audience: [CLIENT.audience],
      scopes: [...CLIENT.scopes],
      issuedAt: now - 1000,
      expiresAt: now + 299_000,
      grant: completing ? "authorization_code" : "refresh_token",
      ...(completing
        ? {
            bootstrap: {
              version: 1,
              loginAttemptId: rows[0].login_attempt_id,
              challenge: rows[0].challenge,
            },
          }
        : {}),
    });
    const result = completing
      ? await core.complete({
          loginAttemptId: rows[0].login_attempt_id,
          accessSecret: ACCESS,
          evidence,
        })
      : await core.validate({
          nativeBindingReference: request.reference,
          accessSecret: ACCESS,
          evidence,
        });
    if (request.action === "exit-after-commit" && result.kind === "account-access")
      process.exit(73);
    process.stdout.write(JSON.stringify({ pid: process.pid, result }));
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  process.stderr.write("Disposable native recovery probe failed\n");
  process.exitCode = 1;
});
