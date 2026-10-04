import { verify, type KeyObject } from "node:crypto";
import { requireCondition, sha256 } from "../foundation/database";
import { MAX_ECONOMIC_JSON_BYTES, parseEconomicJson } from "../foundation/strictJson";

export type SignedArtifact = Readonly<{ payload: string; signature: string }>;
export const MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES = MAX_ECONOMIC_JSON_BYTES;
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_SIGNATURE_BASE64URL_LENGTH = Math.ceil(ED25519_SIGNATURE_BYTES * 4 / 3);
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
/** Shared by verification and service-identity peeking; no decoding, parsing or signature work precedes these bounds. */
export function assertArtifactBounds(input: SignedArtifact): void {
  requireCondition(input && Object.keys(input).sort().join() === "payload,signature" && typeof input.payload === "string" &&
    input.payload.length <= MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES && Buffer.byteLength(input.payload) <= MAX_SIGNED_ARTIFACT_PAYLOAD_BYTES &&
    typeof input.signature === "string" && input.signature.length === ED25519_SIGNATURE_BASE64URL_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(input.signature), "Invalid signed artifact encoding/size.");
}
export function verifyArtifact<T>(input: SignedArtifact, publicKey: KeyObject): Readonly<{ data: T; fingerprint: string }> {
  assertArtifactBounds(input);
  requireCondition(publicKey.type === "public" && publicKey.asymmetricKeyType === "ed25519", "Pinned Ed25519 public trust root required.");
  const signature = Buffer.from(input.signature, "base64url");
  requireCondition(signature.length === ED25519_SIGNATURE_BYTES && signature.toString("base64url") === input.signature &&
    verify(null, Buffer.from(input.payload), publicKey, signature), "Artifact authentication rejected.");
  const data = parseEconomicJson(Buffer.from(input.payload)) as T;
  return frozen({ data, fingerprint: sha256(input.payload) });
}
