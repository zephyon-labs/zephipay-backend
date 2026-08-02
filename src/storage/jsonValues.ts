import type {
  JsonObject,
  JsonValue,
  PaymentTerminalProof,
} from "../payments/paymentTypes";

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new Error("JSON numbers must be finite and integer values must be safe.");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneJsonValue(item)));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) throw new Error("JSON values cannot contain undefined.");
      result[key] = cloneJsonValue(item);
    }
    return Object.freeze(result);
  }
  throw new Error("Value is not JSON-compatible.");
}

export function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJsonValue(value) as JsonObject;
}

export function cloneTerminalProof(proof: PaymentTerminalProof): PaymentTerminalProof {
  if (proof.kind === "PRE_SUBMISSION_REJECTION") {
    return Object.freeze({ ...proof });
  }
  if (proof.kind === "SOLANA_TRANSACTION_ERROR") {
    return Object.freeze({ ...proof, chainError: cloneJsonValue(proof.chainError) });
  }
  return Object.freeze({ ...proof });
}

export function terminalProofToJson(proof: PaymentTerminalProof): JsonObject {
  return cloneJsonObject(proof as unknown as JsonObject);
}
