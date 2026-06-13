export type SettlementProof = {
  success: boolean;
  payer?: string;
  transaction?: string;
  network?: string;
};

export type ZephyonReceiptPreview = {
  source: "x402";
  system: "zephyon";
  receiptMode: "offchain-preview";
  status: string;
  localReceiptId: string;
  createdAt: string;
  payment: {
    source: "x402";
    settlementProvider: string;
    settlementProofLocation: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  };
  resource: {
    path: string;
    description: string;
    access: string;
  };
  futureProtocolBinding: {
    pdaBacked: boolean;
    target: string;
    note: string;
  };
  audit: {
    schemaVersion: string;
    generatedBy: string;
    environment: string;
  };
  settlementProof?: SettlementProof;
};