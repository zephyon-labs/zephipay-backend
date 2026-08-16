export const RUNNABLE_E2E_SCENARIOS = [
  "human-to-human-happy-path", "duplicate-confirm", "duplicate-execute", "refresh-after-execute",
  "recover-after-ambiguous-response", "restart-after-commit", "reconciliation-recovery",
  "receipt-idempotency", "payment-completion-idempotency",
] as const;
export const UNSUPPORTED_AGENT_SCENARIOS = ["human-to-agent", "agent-to-human", "agent-to-agent"] as const;
export type E2eScenario = typeof RUNNABLE_E2E_SCENARIOS[number] | typeof UNSUPPORTED_AGENT_SCENARIOS[number];
export type E2eMode = "OFFLINE" | "LIVE_DEVNET_CANARY";
export type E2eResult = "RUNNING" | "PASSED" | "FAILED" | "UNSUPPORTED";
export type SyntheticActorKind = "human" | "agent";
export type SyntheticTestActor = Readonly<{syntheticActorId:string;accountId:string;actorClass:"synthetic_test";actorKind:SyntheticActorKind;testOrigin:"codex_e2e";createdAt:string}>;
export type E2eTestRun = Readonly<{runId:string;scenarioName:E2eScenario;testOrigin:"codex_e2e";mode:E2eMode;sourceActorId?:string;destinationActorId?:string;sourceActorKind:SyntheticActorKind;destinationActorKind:SyntheticActorKind;startedAt:string;completedAt?:string;result:E2eResult;paymentIntentId?:string;executionId?:string;failureStage?:string;failureReason?:string;invariantViolations:readonly string[];finalPaymentStatus?:string;finalExecutionStatus?:string;receiptCount?:number;commitmentCount?:number;submissionCount?:number;durationMs?:number}>;

export const AGENT_SCENARIO_BLOCKERS:Readonly<Record<typeof UNSUPPORTED_AGENT_SCENARIOS[number],readonly string[]>>=Object.freeze({
  "human-to-agent":["payable agent identity","destination authorization semantics"],
  "agent-to-human":["authenticated agent principal","agent-owned account authorization","execution API authorization"],
  "agent-to-agent":["authenticated agent principal","agent-owned account authorization","payable agent identity","destination authorization semantics","execution API authorization"],
});

