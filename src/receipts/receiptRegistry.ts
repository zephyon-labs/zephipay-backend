type StoredReceipt = Record<string, unknown>;

export type ReceiptRegistry = Readonly<{
  registerReceipt(receipt: StoredReceipt): StoredReceipt;
  getReceipt(receiptId: string): StoredReceipt | null;
  listReceipts(): StoredReceipt[];
}>;

export function createReceiptRegistry(): ReceiptRegistry {
  const receiptRegistry = new Map<string, StoredReceipt>();

  return Object.freeze({
    registerReceipt(receipt: StoredReceipt) {
      const receiptId = receipt.localReceiptId;

      if (typeof receiptId !== "string" || receiptId.length === 0) {
        throw new Error("Cannot register receipt without localReceiptId");
      }

      receiptRegistry.set(receiptId, receipt);

      return receipt;
    },

    getReceipt(receiptId: string) {
      return receiptRegistry.get(receiptId) || null;
    },

    listReceipts() {
      return Array.from(receiptRegistry.values());
    },
  });
}
