import { createHash, timingSafeEqual } from "node:crypto";
import type {
  Binding,
  CanonicalAccountSessionId,
  LoginAttemptId,
  NativeBindingReference,
} from "./contracts";

export const owns = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Capture own data descriptors once. Validation never projects from the original object. */
export function data(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error("Invalid record");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
    required.some((key) => !owns(descriptors, key))
  )
    throw new Error("Invalid fields");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!owns(descriptor, "value")) throw new Error("Accessor rejected");
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512 || value.trim() !== value)
    throw new Error("Invalid text");
  return value;
}
export function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Invalid list");
  const descriptors = Object.getOwnPropertyDescriptors(value as object);
  const size = descriptors.length.value;
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 32 ||
    Reflect.ownKeys(descriptors).length !== size + 1
  )
    throw new Error("Invalid list");
  const result: string[] = [];
  for (let i = 0; i < size; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor || !owns(descriptor, "value")) throw new Error("Invalid list item");
    result.push(text(descriptor.value));
  }
  if (new Set(result).size !== result.length) throw new Error("Duplicate item");
  return Object.freeze(result);
}
export function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid time");
  return value;
}
export function attemptId(value: unknown): LoginAttemptId {
  if (typeof value !== "string" || !/^attempt_[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid attempt ID");
  return value as LoginAttemptId;
}
export function bindingReference(value: unknown): NativeBindingReference {
  if (typeof value !== "string" || !/^binding_[a-f0-9]{32}$/.test(value))
    throw new Error("Invalid binding reference");
  return value as NativeBindingReference;
}
export function accountId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
    throw new Error("Invalid canonical ID");
  return value;
}
export function sessionId(value: unknown): CanonicalAccountSessionId {
  return accountId(value) as CanonicalAccountSessionId;
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid digest or secret encoding");
  return value;
}
export function proofCommitment(
  kind: "access" | "revocation",
  binding: Pick<Binding, "context" | "creationKey">,
  secret: string,
): string {
  // JSON array of validated primitive strings has unambiguous field boundaries.
  const c = binding.context;
  const encoded = JSON.stringify([
    "zephipay-native-session-v1",
    kind,
    text(c.environment),
    text(c.issuer),
    text(c.clientId),
    text(c.audience),
    digest(binding.creationKey),
    digest(secret),
  ]);
  return createHash("sha256").update(encoded).digest("hex");
}
export function matchesProof(
  kind: "access" | "revocation",
  binding: Binding,
  secret: string,
): boolean {
  const expected = digest(
    kind === "access" ? binding.accessCommitment : binding.revocationCommitment,
  );
  return timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(proofCommitment(kind, binding, secret), "hex"),
  );
}
