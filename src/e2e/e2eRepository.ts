import type {E2eTestRun,SyntheticTestActor} from "./e2eTypes";
export interface E2eReliabilityRepository {
  createActor(input:Omit<SyntheticTestActor,"createdAt"> & {createdAt?:string}):Promise<SyntheticTestActor>;
  findActor(syntheticActorId:string):Promise<SyntheticTestActor|undefined>;
  startRun(input:Omit<E2eTestRun,"result"|"invariantViolations">):Promise<E2eTestRun>;
  finishRun(runId:string,input:Pick<E2eTestRun,"result"|"completedAt"|"paymentIntentId"|"executionId"|"failureStage"|"failureReason"|"invariantViolations"|"finalPaymentStatus"|"finalExecutionStatus"|"receiptCount"|"commitmentCount"|"submissionCount"|"durationMs">):Promise<E2eTestRun>;
  findRun(runId:string):Promise<E2eTestRun|undefined>;
}

