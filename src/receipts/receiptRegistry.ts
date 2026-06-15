type StoredReceipt = Record<string, unknown>;

const receiptRegistry = new Map<string, StoredReceipt>();

export function registerReceipt(receipt: StoredReceipt) {
  const receiptId = receipt.localReceiptId;

  if (typeof receiptId !== "string" || receiptId.length === 0) {
    throw new Error("Cannot register receipt without localReceiptId");
  }

  receiptRegistry.set(receiptId, receipt);

  return receipt;
}

export function getReceipt(receiptId: string) {
  return receiptRegistry.get(receiptId) || null;
}

export function listReceipts() {
  return Array.from(receiptRegistry.values());
}