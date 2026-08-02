import type { PaymentEvent } from "../payments/paymentTypes";
import type {
  AppendInformationalPaymentEventInput,
  PaymentLifecycleRepository,
} from "../storage/storageContracts";

export interface PaymentTelemetryHook {
  persistInformationalEvent(input: AppendInformationalPaymentEventInput): Promise<PaymentEvent>;
}

export class DurablePaymentTelemetryHook implements PaymentTelemetryHook {
  constructor(
    private readonly lifecycleRepository: PaymentLifecycleRepository,
  ) {}

  persistInformationalEvent(input: AppendInformationalPaymentEventInput): Promise<PaymentEvent> {
    return this.lifecycleRepository.appendInformationalEvent(input);
  }
}
