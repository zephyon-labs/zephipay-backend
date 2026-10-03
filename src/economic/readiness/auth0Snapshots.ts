import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KeyObject } from "node:crypto";
import type { JSONWebKeySet } from "jose";
import { requireCondition, sha256 } from "../foundation/database";
import { initializeProviderKeyResolver } from "../provider/providerTokenVerifier";
import { assertVerifiedDeployment, type VerifiedDeployment } from "./deploymentProfile";
import { MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES, digest, frozen, positive, verifyArtifact, type SignedArtifact } from "./signedArtifact";

type SnapshotDocument = {
  type: "zephipay-auth0-snapshot-v1"; provider: "auth0"; deploymentId: string; environment: string; issuer: string;
  configuration: string; source: string; adapter: string; obtainedAt: number; validUntil: number;
  revision: number; previousRevision: number; jwks: JSONWebKeySet;
};
type HeadDocument = { type: "zephipay-auth0-head-v1"; configuration: string; revision: number; fingerprint: string; expiresAt: number };
export type SnapshotProvenance = Readonly<Omit<SnapshotDocument, "jwks"> & { fingerprint: string; normalizedKeysFingerprint: string }>;
type ActiveSnapshot = Readonly<{ provenance: SnapshotProvenance; resolver: Awaited<ReturnType<typeof initializeProviderKeyResolver>> }>;
export interface SnapshotTransport {
  acquire(request: Readonly<{ url: string; maxBytes: typeof MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES; redirects: "reject"; signal: AbortSignal }>): Promise<SignedArtifact>;
}

function validateThumbprint(value: unknown, name: "x5t" | "x5t#S256"): void {
  // RFC 7517 binary digests, plus Auth0's documented x5t-only base64url(uppercase ASCII hex) form.
  // Length selects disjoint representations before decoding. No raw hex, padding, case folding or repair.
  const rawBytes = name === "x5t" ? 20 : 32;
  requireCondition(typeof value === "string" &&
    (value.length === Math.ceil(rawBytes * 4 / 3) || (name === "x5t" && value.length === 54)) &&
    /^[A-Za-z0-9_-]+$/.test(value), "Invalid key thumbprint metadata.");
  const decoded = Buffer.from(value, "base64url");
  requireCondition(decoded.toString("base64url") === value &&
    (decoded.length === rawBytes || (name === "x5t" && decoded.length === 40 && /^[0-9A-F]{40}$/.test(decoded.toString("latin1")))),
    "Invalid key thumbprint metadata.");
}

/** Certificates/thumbprints are public source metadata, not an alternate verification trust path. */
function projectAuth0Keys(input: JSONWebKeySet): JSONWebKeySet {
  requireCondition(input && Object.keys(input).join() === "keys" && Array.isArray(input.keys) && input.keys.length > 0 && input.keys.length <= 16, "Invalid Auth0 JWKS.");
  const allowed = ["kty","kid","n","e","alg","use","key_ops","x5c","x5t","x5t#S256"];
  return { keys: input.keys.map(key => {
    requireCondition(key && Object.keys(key).every(k => allowed.includes(k)), "Unsupported Auth0 key metadata.");
    for (const name of ["x5t", "x5t#S256"] as const) if (name in key) validateThumbprint(key[name], name);
    if ("x5c" in key) requireCondition(Array.isArray(key.x5c) && key.x5c.length > 0 && key.x5c.length <= 4 && key.x5c.every(v => typeof v === "string" && v.length > 0 && v.length <= 8192 && Buffer.from(v,"base64").toString("base64") === v), "Invalid certificate metadata.");
    return Object.fromEntries(Object.entries(key).filter(([name]) => !["x5c","x5t","x5t#S256"].includes(name)));
  }) } as JSONWebKeySet;
}

/** No remote client or network defaults. Signed public artifacts may be loaded from a durable offline cache. */
export class Auth0Snapshots {
  private active?: ActiveSnapshot;
  constructor(readonly configuration: VerifiedDeployment, private readonly snapshotRoot: KeyObject, private readonly readHead: () => Promise<SignedArtifact>) {
    assertVerifiedDeployment(configuration);
  }
  private async registered(): Promise<HeadDocument> {
    const h = verifyArtifact<HeadDocument>(await this.readHead(), this.snapshotRoot).data;
    requireCondition(h.type === "zephipay-auth0-head-v1" && h.configuration === this.configuration.fingerprint && positive(h.revision) && digest(h.fingerprint) && positive(h.expiresAt) && h.expiresAt > Date.now()/1000, "Stale snapshot registration.");
    return h;
  }
  private async matches(s: ActiveSnapshot): Promise<void> {
    const h = await this.registered();
    requireCondition(h.revision === s.provenance.revision && h.fingerprint === s.provenance.fingerprint && s.provenance.validUntil > Date.now()/1000, "Snapshot revision/fingerprint/expiry mismatch.");
  }
  async install(input: SignedArtifact): Promise<SnapshotProvenance> {
    const { data: s, fingerprint } = verifyArtifact<SnapshotDocument>(input, this.snapshotRoot), p = this.configuration.profile, prior = this.active;
    requireCondition(Object.keys(s).sort().join() === ["type","provider","deploymentId","environment","issuer","configuration","source","adapter","obtainedAt","validUntil","revision","previousRevision","jwks"].sort().join(), "Unsupported snapshot fields.");
    requireCondition(s.type === "zephipay-auth0-snapshot-v1" && s.provider === p.provider && s.deploymentId === p.deploymentId && s.environment === p.environment && s.issuer === p.issuer &&
      s.configuration === this.configuration.fingerprint && s.source === p.keySource && s.adapter === p.snapshotAdapter, "Snapshot provenance mismatch.");
    requireCondition(positive(s.revision) && Number.isSafeInteger(s.previousRevision) && s.previousRevision >= 0 && s.previousRevision < s.revision &&
      (!prior || (s.revision > prior.provenance.revision && s.previousRevision === prior.provenance.revision)), "Snapshot rollback/chain rejected.");
    const now = Date.now()/1000;
    requireCondition(positive(s.obtainedAt) && positive(s.validUntil) && s.obtainedAt <= now && s.validUntil > now && s.validUntil - s.obtainedAt <= p.maxSnapshotAgeSeconds, "Snapshot validity rejected.");
    const keys = projectAuth0Keys(s.jwks), { jwks: _publicKeys, ...metadata } = s;
    const provenance = frozen({ ...metadata, fingerprint, normalizedKeysFingerprint: sha256(JSON.stringify(keys)) });
    // Validate the externally anchored head before expensive cryptographic initialization as well.
    const head = await this.registered(); requireCondition(head.revision === s.revision && head.fingerprint === fingerprint, "Snapshot registration mismatch.");
    const candidate = Object.freeze({ provenance, resolver: await initializeProviderKeyResolver(keys) });
    await this.matches(candidate);
    requireCondition(this.active === prior, "Concurrent snapshot replacement rejected.");
    this.active = candidate;
    return provenance;
  }
  async current(): Promise<ActiveSnapshot> {
    const snapshot = this.active; requireCondition(snapshot, "Snapshot not initialized.");
    await this.matches(snapshot); requireCondition(this.active === snapshot, "Snapshot changed during readiness."); return snapshot;
  }
  async assertCurrent(snapshot: ActiveSnapshot): Promise<void> { requireCondition(this.active === snapshot, "Retired snapshot."); await this.matches(snapshot); requireCondition(this.active === snapshot, "Retired snapshot."); }
  /** Durable audit record only: never accepted as a key/configuration trust source. Directory is operator-owned. */
  async persistProvenance(directory: string): Promise<string> {
    const { provenance } = await this.current(), body = JSON.stringify(provenance) + "\n";
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${provenance.fingerprint}.json`);
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      requireCondition(await readFile(path, "utf8") === body, "Existing provenance record differs."); return path;
    }
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    const parent = await open(directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
    return path;
  }
  async refresh(transport: SnapshotTransport): Promise<SnapshotProvenance> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const input = await Promise.race([transport.acquire({ url: this.configuration.profile.keySource, maxBytes: MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES, redirects: "reject", signal: controller.signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Snapshot delivery timeout.")); }, 5000); })]);
      return await this.install(input);
    } finally { if (timer) clearTimeout(timer); }
  }
}
