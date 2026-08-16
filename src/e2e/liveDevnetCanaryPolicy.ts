import type{E2eMode,SyntheticTestActor}from"./e2eTypes";
export type LiveCanaryInput=Readonly<{mode:E2eMode;explicitLiveFlag:boolean;liveConfirmation:string|undefined;network:string;amountRaw:bigint;source:SyntheticTestActor;destination:SyntheticTestActor;submissionEnabled:boolean;reconciliationEnabled:boolean;existingCommitmentCount:number}>;
export function assertLiveDevnetCanary(input:LiveCanaryInput):void{
 if(input.mode!=="LIVE_DEVNET_CANARY"||!input.explicitLiveFlag)throw new Error("Live Devnet requires explicit --live-devnet invocation.");
 if(input.liveConfirmation!=="I_UNDERSTAND_THIS_SUBMITS_DEVNET_USDC")throw new Error("Live Devnet confirmation is missing.");
 if(input.network!=="solana-devnet")throw new Error("Only solana-devnet is permitted; Mainnet is rejected.");
 if(input.amountRaw<=0n||input.amountRaw>1000n)throw new Error("Live canary amount must be at most 1000 raw USDC units.");
 for(const actor of[input.source,input.destination])if(actor.actorClass!=="synthetic_test"||actor.testOrigin!=="codex_e2e")throw new Error("Live canary actors must be codex_e2e synthetic_test actors.");
 if(!input.submissionEnabled||!input.reconciliationEnabled)throw new Error("Live canary submission and reconciliation capabilities must both be explicit.");
 if(input.existingCommitmentCount!==0)throw new Error("A committed execution is observe/reconcile-only and cannot enter live submission.");
}

