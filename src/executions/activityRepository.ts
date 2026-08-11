import type { PaymentIdentitySnapshot } from "../payments/paymentTypes";
import type { ExecutionStatus } from "./executionTypes";

export type ActivityFact = Readonly<{
  paymentIntentId: string;
  userConfirmedAt?: string;
  recipientSnapshot?: PaymentIdentitySnapshot;
  amountUnits: string;
  asset: "USDC";
  memo: string | null;
  createdAt: string;
  executionId?: string;
  executionStatus?: ExecutionStatus;
  settledAt?: string;
  receiptId?: string;
}>;

export interface ActivityRepository {
  listByActor(actorSubject: string, limit: number): Promise<ActivityFact[]>;
}
