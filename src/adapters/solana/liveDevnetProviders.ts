import type{DevnetBlockhashSource,SolanaChainObservation,SolanaReconciliationRpc,SolanaSubmissionRpc}from"zephyon-protocol";
import type{DevnetBlockHeightSource,DevnetReconciliationProvider}from"../../devnet/devnetOrchestrationService";
import{DevnetRpcError,SingleAttemptDevnetJsonRpc,record}from"./devnetJsonRpc";

export class HeliusDevnetSubmissionRpc implements SolanaSubmissionRpc{
  readonly identity;
  constructor(providerId:string,private readonly rpc:SingleAttemptDevnetJsonRpc,private readonly clock=()=>new Date().toISOString()){this.identity=Object.freeze({providerId,network:"devnet" as const,role:"submission" as const});}
  async submitExactSignedTransaction(bytes:Uint8Array){const result=await this.rpc.call("sendTransaction",[Buffer.from(bytes).toString("base64"),{encoding:"base64",skipPreflight:false,maxRetries:0}]);if(typeof result!=="string"||!result||result.length>256)throw new DevnetRpcError("INVALID_RESPONSE",true);return Object.freeze({signature:result,acceptedAt:this.clock()});}
}
export class IndependentDevnetReconciliationRpc implements SolanaReconciliationRpc,DevnetReconciliationProvider{
  readonly identity;
  constructor(providerId:string,private readonly rpc:SingleAttemptDevnetJsonRpc,private readonly clock=()=>new Date().toISOString()){this.identity=Object.freeze({providerId,network:"devnet" as const,role:"reconciliation" as const});}
  async observeSignature(signature:string):Promise<SolanaChainObservation>{const result=await this.rpc.call("getSignatureStatuses",[[signature],{searchTransactionHistory:true}]);if(!record(result)||!Array.isArray(result.value)||result.value.length>1)throw new DevnetRpcError("INVALID_RESPONSE",true);const value=result.value[0];if(value===null||value===undefined)return Object.freeze({status:"missing",observedAt:this.clock(),providerId:this.identity.providerId});if(!record(value))throw new DevnetRpcError("INVALID_RESPONSE",true);const slot=integer(value.slot),confirmation=typeof value.confirmationStatus==="string"&&value.confirmationStatus.length<=32?value.confirmationStatus:undefined,observedAt=this.clock();if(value.err!==null&&value.err!==undefined)return Object.freeze({status:"failed",observedAt,failedAt:observedAt,slot,errorCode:"PROVIDER_REPORTED_FAILURE",providerId:this.identity.providerId});if(confirmation==="finalized")return Object.freeze({status:"settled",observedAt,settledAt:observedAt,slot,confirmationStatus:confirmation,providerId:this.identity.providerId});return Object.freeze({status:"pending",observedAt,slot,...(confirmation?{confirmationStatus:confirmation}:{}),providerId:this.identity.providerId});}
}
/** Read-only block data is deliberately bound only to the reconciliation-side transport. */
export class ReconciliationDevnetBlockDataSource implements DevnetBlockhashSource,DevnetBlockHeightSource{
  constructor(private readonly reconciliationRpc:SingleAttemptDevnetJsonRpc){}
  async getLatestDevnetBlockhash(){const result=await this.reconciliationRpc.call("getLatestBlockhash",[{commitment:"finalized"}]);if(!record(result)||!record(result.value)||typeof result.value.blockhash!=="string"||result.value.blockhash.length>128)throw new DevnetRpcError("INVALID_RESPONSE",true);return Object.freeze({recentBlockhash:result.value.blockhash,lastValidBlockHeight:integer(result.value.lastValidBlockHeight)});}
  async getCurrentDevnetBlockHeight(){return integer(await this.reconciliationRpc.call("getBlockHeight",[{commitment:"finalized"}]));}
}
function integer(value:unknown){if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw new DevnetRpcError("INVALID_RESPONSE",true);return String(value);}
