import type{DevnetTransactionSigner}from"zephyon-protocol";
import{SingleAttemptDevnetJsonRpc,type JsonRpcFetch}from"../adapters/solana/devnetJsonRpc";
import{HeliusDevnetSubmissionRpc,IndependentDevnetReconciliationRpc,ReconciliationDevnetBlockDataSource}from"../adapters/solana/liveDevnetProviders";
import{AdaptiveWorkerLoop}from"../executions/adaptiveWorkerLoop";
import{Aes256GcmPreparedTransactionCipher}from"./preparedTransactionCipher";
import type{DevnetExecutionStateRepository}from"./devnetExecutionState";
import{DevnetOrchestrationService}from"./devnetOrchestrationService";
import type{DevnetRecoveryHandlers}from"./devnetRecoveryWorker";
import{DevnetRecoveryWorker}from"./devnetRecoveryWorker";
import type{DevnetRecoveryRepository}from"./devnetRecoveryRepository";
import type{DevnetLiveConfiguration}from"./devnetLiveConfiguration";

export type LiveDevnetComposition=Readonly<{orchestration:DevnetOrchestrationService;recoveryWorker:DevnetRecoveryWorker;workerLoop:AdaptiveWorkerLoop;submissionProvider:HeliusDevnetSubmissionRpc;reconciliationProvider:IndependentDevnetReconciliationRpc;blockDataSource:ReconciliationDevnetBlockDataSource}>;
export type LiveDevnetCompositionDependencies=Readonly<{executionState:DevnetExecutionStateRepository;recoveryRepository:DevnetRecoveryRepository;signer?:DevnetTransactionSigner;recoveryHandlers:DevnetRecoveryHandlers;fetch?:JsonRpcFetch;workerId:string}>;

/** Internal, inert composition. Construction never starts polling or performs RPC. */
export function createLiveDevnetComposition(config:DevnetLiveConfiguration,deps:LiveDevnetCompositionDependencies):LiveDevnetComposition{
  if(!config.enabled)throw new Error("Live Devnet composition requires enabled configuration.");
  const signer=signerBoundary(config,deps.signer);
  const submissionRpc=new SingleAttemptDevnetJsonRpc(config.submissionUrl!,config.requestTimeoutMs!,deps.fetch,config.submissionApiKey),reconciliationRpc=new SingleAttemptDevnetJsonRpc(config.reconciliationUrl!,config.requestTimeoutMs!,deps.fetch);
  const submissionProvider=new HeliusDevnetSubmissionRpc(config.submissionProviderId!,submissionRpc),reconciliationProvider=new IndependentDevnetReconciliationRpc(config.reconciliationProviderId!,reconciliationRpc),blockDataSource=new ReconciliationDevnetBlockDataSource(reconciliationRpc);
  const orchestration=new DevnetOrchestrationService(deps.executionState,new Aes256GcmPreparedTransactionCipher(config.encryptionKey!,config.encryptionKeyVersion!),Object.freeze({cluster:"solana-devnet",asset:"USDC",mint:config.mint!,decimals:config.decimals!,sourceTokenAccount:config.sourceTokenAccount!,policyHash:config.policyHash!,submissionProviderId:config.submissionProviderId!,reconciliationProviderId:config.reconciliationProviderId!}),blockDataSource,signer,blockDataSource,reconciliationProvider,submissionProvider,{submissionEnabled:config.submissionEnabled,reconciliationEnabled:config.reconciliationEnabled});
  const recoveryWorker=new DevnetRecoveryWorker(deps.recoveryRepository,deps.recoveryHandlers,deps.workerId,{preparationEnabled:config.preparationEnabled,reconciliationEnabled:config.reconciliationEnabled});
  const workerLoop=new AdaptiveWorkerLoop(()=>recoveryWorker.iterate());
  return Object.freeze({orchestration,recoveryWorker,workerLoop,submissionProvider,reconciliationProvider,blockDataSource});
}
function signerBoundary(config:DevnetLiveConfiguration,delegate?:DevnetTransactionSigner):DevnetTransactionSigner{
  if(delegate&&(delegate.keyId!==config.signerKeyId||delegate.keyVersion!==config.signerKeyVersion||delegate.publicKey!==config.signerPublicKey))throw new Error("Injected Devnet signer identity does not match configured metadata.");
  if(config.preparationEnabled&&!delegate)throw new Error("An injected server-side Devnet signer is required when preparation is enabled.");
  return delegate??Object.freeze({keyId:config.signerKeyId!,keyVersion:config.signerKeyVersion!,publicKey:config.signerPublicKey!,async signTransaction():Promise<never>{throw new Error("Devnet signer custody is unavailable.");}});
}
