import { verify, type KeyObject } from "node:crypto";
import { requireCondition, sha256 } from "../foundation/database";
import { parseEconomicJson } from "../foundation/strictJson";

export type SignedArtifact = Readonly<{ payload: string; signature: string }>;
export function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
export function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
export function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function verifyArtifact<T>(input: SignedArtifact, publicKey: KeyObject): Readonly<{ data: T; fingerprint: string }> {
  requireCondition(publicKey.type === "public" && publicKey.asymmetricKeyType === "ed25519", "Pinned Ed25519 public trust root required.");
  requireCondition(input && Object.keys(input).sort().join() === "payload,signature" && typeof input.payload === "string" &&
    Buffer.byteLength(input.payload) <= 131072 && typeof input.signature === "string", "Invalid signed artifact.");
  const signature = Buffer.from(input.signature, "base64url");
  requireCondition(signature.length === 64 && signature.toString("base64url") === input.signature &&
    verify(null, Buffer.from(input.payload), publicKey, signature), "Artifact authentication rejected.");
  const data = parseEconomicJson(Buffer.from(input.payload)) as T;
  return frozen({ data, fingerprint: sha256(input.payload) });
}
