import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EncryptedSignedTransaction } from "./devnetExecutionState";

export type PreparedTransactionEncryptionContext = Readonly<{ executionId: string; preparationId: string; keyVersion: string }>;

export class Aes256GcmPreparedTransactionCipher {
  private readonly key: Buffer;
  constructor(key: Uint8Array, readonly keyVersion: string, private readonly nonce: () => Buffer = () => randomBytes(12)) {
    this.key = Buffer.from(key);
    if (this.key.length !== 32) throw new Error("AES-256-GCM requires an externally supplied 32-byte key.");
    if (!keyVersion || keyVersion.trim() !== keyVersion) throw new Error("Encryption key version must be a non-empty trimmed string.");
  }

  encrypt(signedTransactionBase64: string, context: PreparedTransactionEncryptionContext): EncryptedSignedTransaction {
    this.assertContext(context);
    const iv = this.nonce(); if (iv.length !== 12) throw new Error("AES-GCM initialization vector must be 12 bytes.");
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([cipher.update(signedTransactionBase64, "utf8"), cipher.final()]);
    return Object.freeze({ algorithm: "aes-256-gcm", keyVersion: this.keyVersion, initializationVector: Buffer.from(iv), authenticationTag: cipher.getAuthTag(), ciphertext });
  }

  decrypt(value: EncryptedSignedTransaction, context: PreparedTransactionEncryptionContext): string {
    this.assertContext(context);
    if (value.algorithm !== "aes-256-gcm" || value.keyVersion !== this.keyVersion) throw new Error("Prepared transaction encryption key version mismatch.");
    const decipher = createDecipheriv("aes-256-gcm", this.key, value.initializationVector);
    decipher.setAAD(this.aad(context)); decipher.setAuthTag(value.authenticationTag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
  }

  private aad(value: PreparedTransactionEncryptionContext): Buffer {
    return Buffer.from(`zephipay-devnet-preparation-v1\0${value.executionId}\0${value.preparationId}\0${value.keyVersion}`, "utf8");
  }
  private assertContext(value: PreparedTransactionEncryptionContext): void {
    if (!value.executionId || !value.preparationId || value.keyVersion !== this.keyVersion) throw new Error("Prepared transaction encryption context mismatch.");
  }
}
