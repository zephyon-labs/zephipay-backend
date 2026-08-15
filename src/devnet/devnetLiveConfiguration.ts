export type DevnetLiveConfiguration=Readonly<{
  enabled:boolean;browserApiEnabled?:boolean;preparationEnabled:boolean;submissionEnabled:boolean;reconciliationEnabled:boolean;requestTimeoutMs:number;
  submissionProviderId?:string;submissionUrl?:string;submissionApiKey?:string;reconciliationProviderId?:string;reconciliationUrl?:string;
  encryptionKey?:Buffer;encryptionKeyVersion?:string;signerSecretKey?:Buffer;signerKeyId?:string;signerKeyVersion?:string;signerPublicKey?:string;
  mint?:string;decimals?:number;sourceTokenAccount?:string;
}>;
type Environment=Readonly<Record<string,string|undefined>>;
const bool=(value:string|undefined,name:string)=>{if(value===undefined)return false;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;throw new Error(`${name} must be true or false.`);};
const required=(env:Environment,name:string)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is required for the enabled Devnet capability.`);return value;};
const providerId=(env:Environment,name:string,needed:boolean)=>{const value=env[name];if(!needed&&!value)return undefined;if(!value||value.trim()!==value||value.length>128)throw new Error(`${name} must be a bounded non-empty provider identity.`);return value;};
const rpcUrl=(env:Environment,name:string,host:string,needed:boolean)=>{const value=env[name]?.trim();if(!needed&&!value)return undefined;if(!value)throw new Error(`${name} is required for the enabled Devnet capability.`);let parsed:URL;try{parsed=new URL(value);}catch{throw new Error(`${name} must be an approved HTTPS Devnet URL.`);}if(parsed.protocol!=="https:"||parsed.hostname!==host||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error(`${name} must be an approved HTTPS Devnet URL.`);return value;};
const decoded=(env:Environment,name:string,bytes:number)=>{const encoded=required(env,name),value=Buffer.from(encoded,"base64");if(value.length!==bytes||value.toString("base64")!==encoded)throw new Error(`${name} has an invalid encoded length.`);return value;};

/** Capability-scoped parsing. Errors identify fields but never supplied values. */
export function parseDevnetLiveConfiguration(env:Environment=process.env):DevnetLiveConfiguration{
  const enabled=bool(env.DEVNET_INTEGRATION_ENABLED,"DEVNET_INTEGRATION_ENABLED");
  if(!enabled)return Object.freeze({enabled:false,preparationEnabled:false,submissionEnabled:false,reconciliationEnabled:false,requestTimeoutMs:5_000});
  const browserApiEnabled=bool(env.DEVNET_BROWSER_API_ENABLED,"DEVNET_BROWSER_API_ENABLED"),preparationRequested=bool(env.DEVNET_PREPARATION_ENABLED,"DEVNET_PREPARATION_ENABLED"),submissionEnabled=bool(env.DEVNET_SUBMISSION_ENABLED,"DEVNET_SUBMISSION_ENABLED"),reconciliationEnabled=bool(env.DEVNET_RECONCILIATION_ENABLED,"DEVNET_RECONCILIATION_ENABLED"),preparationEnabled=preparationRequested||submissionEnabled;
  const requestTimeoutMs=env.DEVNET_RPC_TIMEOUT_MS===undefined?5_000:Number(env.DEVNET_RPC_TIMEOUT_MS);if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<100||requestTimeoutMs>30_000)throw new Error("DEVNET_RPC_TIMEOUT_MS must be between 100 and 30000 milliseconds.");
  const reconciliationNeeded=reconciliationEnabled||preparationEnabled,submissionIdentityNeeded=preparationEnabled||env.DEVNET_SUBMISSION_PROVIDER_ID!==undefined,submissionEndpointNeeded=submissionEnabled||env.DEVNET_SUBMISSION_RPC_URL!==undefined||env.DEVNET_SUBMISSION_API_KEY!==undefined;
  const submissionProviderId=providerId(env,"DEVNET_SUBMISSION_PROVIDER_ID",submissionIdentityNeeded),submissionUrl=rpcUrl(env,"DEVNET_SUBMISSION_RPC_URL","devnet.helius-rpc.com",submissionEndpointNeeded),submissionApiKey=env.DEVNET_SUBMISSION_API_KEY?.trim()||undefined;
  if(submissionEndpointNeeded&&!submissionProviderId)throw new Error("DEVNET_SUBMISSION_PROVIDER_ID is required for configured submission infrastructure.");if(submissionEndpointNeeded&&!submissionApiKey)throw new Error("DEVNET_SUBMISSION_API_KEY is required for configured Helius Devnet infrastructure.");
  const reconciliationProviderId=providerId(env,"DEVNET_RECONCILIATION_PROVIDER_ID",reconciliationNeeded),reconciliationUrl=rpcUrl(env,"DEVNET_RECONCILIATION_RPC_URL","api.devnet.solana.com",reconciliationNeeded);
  if(submissionProviderId&&reconciliationProviderId&&submissionProviderId===reconciliationProviderId)throw new Error("Devnet submission and reconciliation provider identities must be distinct.");
  const signerSecret=env.DEVNET_SIGNER_SECRET_KEY_BASE64?.trim();const preparation=preparationEnabled?{encryptionKey:decoded(env,"DEVNET_PREPARATION_ENCRYPTION_KEY_BASE64",32),encryptionKeyVersion:required(env,"DEVNET_PREPARATION_ENCRYPTION_KEY_VERSION"),...(signerSecret?{signerSecretKey:decoded(env,"DEVNET_SIGNER_SECRET_KEY_BASE64",64)}:{}),signerKeyId:required(env,"DEVNET_SIGNER_KEY_ID"),signerKeyVersion:required(env,"DEVNET_SIGNER_KEY_VERSION"),signerPublicKey:required(env,"DEVNET_SIGNER_PUBLIC_KEY"),mint:required(env,"DEVNET_USDC_MINT"),decimals:decimal(env),sourceTokenAccount:required(env,"DEVNET_SOURCE_TOKEN_ACCOUNT")}:{};
  return Object.freeze({enabled,browserApiEnabled,preparationEnabled,submissionEnabled,reconciliationEnabled,requestTimeoutMs,submissionProviderId,submissionUrl,submissionApiKey,reconciliationProviderId,reconciliationUrl,...preparation});
}
function decimal(env:Environment){const value=Number(required(env,"DEVNET_MINT_DECIMALS"));if(!Number.isInteger(value)||value<0||value>18)throw new Error("DEVNET_MINT_DECIMALS must be an integer from 0 through 18.");return value;}
