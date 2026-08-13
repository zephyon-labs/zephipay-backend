export type DevnetLiveConfiguration=Readonly<{
  enabled:boolean;preparationEnabled:boolean;submissionEnabled:boolean;reconciliationEnabled:boolean;
  submissionProviderId?:string;submissionUrl?:string;submissionApiKey?:string;
  reconciliationProviderId?:string;reconciliationUrl?:string;
  encryptionKey?:Buffer;encryptionKeyVersion?:string;signerKeyId?:string;signerKeyVersion?:string;signerPublicKey?:string;
  mint?:string;decimals?:number;sourceTokenAccount?:string;policyHash?:string;requestTimeoutMs?:number;
}>;

type Environment=Readonly<Record<string,string|undefined>>;
const bool=(value:string|undefined,name:string)=>{if(value===undefined)return false;const normalized=value.trim().toLowerCase();if(normalized==="true")return true;if(normalized==="false")return false;throw new Error(`${name} must be true or false.`);};
const required=(env:Environment,name:string)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is required for enabled Devnet integration.`);return value;};
const url=(value:string,name:string,host:string)=>{let parsed:URL;try{parsed=new URL(value);}catch{throw new Error(`${name} must be an approved HTTPS Devnet URL.`);}if(parsed.protocol!=="https:"||parsed.hostname!==host||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error(`${name} must be an approved HTTPS Devnet URL.`);return value;};
const providerId=(env:Environment,name:string)=>{const value=env[name];if(!value||value.trim()!==value||value.length>128)throw new Error(`${name} must be a bounded non-empty provider identity.`);return value;};

/** Parses live Devnet configuration without ever including supplied values in errors. */
export function parseDevnetLiveConfiguration(env:Environment=process.env):DevnetLiveConfiguration{
  const enabled=bool(env.DEVNET_INTEGRATION_ENABLED,"DEVNET_INTEGRATION_ENABLED");
  if(!enabled)return Object.freeze({enabled:false,preparationEnabled:false,submissionEnabled:false,reconciliationEnabled:false});
  const preparationEnabled=bool(env.DEVNET_PREPARATION_ENABLED,"DEVNET_PREPARATION_ENABLED"),submissionEnabled=bool(env.DEVNET_SUBMISSION_ENABLED,"DEVNET_SUBMISSION_ENABLED"),reconciliationEnabled=bool(env.DEVNET_RECONCILIATION_ENABLED,"DEVNET_RECONCILIATION_ENABLED");
  const submissionProviderId=providerId(env,"DEVNET_SUBMISSION_PROVIDER_ID"),reconciliationProviderId=providerId(env,"DEVNET_RECONCILIATION_PROVIDER_ID");
  if(submissionProviderId===reconciliationProviderId)throw new Error("Devnet submission and reconciliation provider identities must be distinct.");
  const submissionUrl=url(required(env,"DEVNET_SUBMISSION_RPC_URL"),"DEVNET_SUBMISSION_RPC_URL","devnet.helius-rpc.com"),reconciliationUrl=url(required(env,"DEVNET_RECONCILIATION_RPC_URL"),"DEVNET_RECONCILIATION_RPC_URL","api.devnet.solana.com");
  if(new URL(submissionUrl).origin+new URL(submissionUrl).pathname===new URL(reconciliationUrl).origin+new URL(reconciliationUrl).pathname)throw new Error("Devnet submission and reconciliation endpoints must be distinct.");
  const encoded=required(env,"DEVNET_PREPARATION_ENCRYPTION_KEY_BASE64"),encryptionKey=Buffer.from(encoded,"base64");if(encryptionKey.length!==32||encryptionKey.toString("base64")!==encoded)throw new Error("DEVNET_PREPARATION_ENCRYPTION_KEY_BASE64 must encode exactly 32 bytes.");
  const decimals=Number(required(env,"DEVNET_MINT_DECIMALS"));if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error("DEVNET_MINT_DECIMALS must be an integer from 0 through 18.");
  const requestTimeoutMs=env.DEVNET_RPC_TIMEOUT_MS===undefined?5_000:Number(env.DEVNET_RPC_TIMEOUT_MS);if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<100||requestTimeoutMs>30_000)throw new Error("DEVNET_RPC_TIMEOUT_MS must be between 100 and 30000 milliseconds.");
  const submissionApiKey=env.DEVNET_SUBMISSION_API_KEY?.trim()||undefined;if(submissionEnabled&&!submissionApiKey)throw new Error("DEVNET_SUBMISSION_API_KEY is required when Devnet submission is enabled.");
  const policyHash=required(env,"DEVNET_POLICY_HASH");if(!/^[a-f0-9]{64}$/.test(policyHash))throw new Error("DEVNET_POLICY_HASH must be a lowercase SHA-256 digest.");
  return Object.freeze({enabled,preparationEnabled,submissionEnabled,reconciliationEnabled,submissionProviderId,submissionUrl,submissionApiKey,reconciliationProviderId,reconciliationUrl,encryptionKey,encryptionKeyVersion:required(env,"DEVNET_PREPARATION_ENCRYPTION_KEY_VERSION"),signerKeyId:required(env,"DEVNET_SIGNER_KEY_ID"),signerKeyVersion:required(env,"DEVNET_SIGNER_KEY_VERSION"),signerPublicKey:required(env,"DEVNET_SIGNER_PUBLIC_KEY"),mint:required(env,"DEVNET_USDC_MINT"),decimals,sourceTokenAccount:required(env,"DEVNET_SOURCE_TOKEN_ACCOUNT"),policyHash,requestTimeoutMs});
}
