export type JsonRpcFetch=(input:string,init:Readonly<{method:"POST";headers:Readonly<Record<string,string>>;body:string;signal:AbortSignal}>)=>Promise<Readonly<{ok:boolean;text():Promise<string>}>>;
export class DevnetRpcError extends Error{constructor(readonly code:"TIMEOUT_OR_NETWORK"|"HTTP"|"INVALID_RESPONSE"|"PROVIDER",readonly contactMayHaveOccurred:boolean){super(`Devnet RPC ${code.toLowerCase().replace(/_/g," ")}.`);this.name="DevnetRpcError";}}
export class SingleAttemptDevnetJsonRpc{
  private sequence=0;
  constructor(private readonly endpoint:string,private readonly timeoutMs:number,private readonly request:JsonRpcFetch=globalThis.fetch as JsonRpcFetch,private readonly apiKey?:string){}
  async call(method:string,params:readonly unknown[]):Promise<unknown>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);try{let response;try{const endpoint=this.apiKey?appendApiKey(this.endpoint,this.apiKey):this.endpoint;response=await this.request(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++this.sequence,method,params}),signal:controller.signal});}catch{throw new DevnetRpcError("TIMEOUT_OR_NETWORK",true);}if(!response.ok)throw new DevnetRpcError("HTTP",true);let body:unknown;try{const text=await response.text();if(text.length>65_536)throw new Error();body=JSON.parse(text);}catch{throw new DevnetRpcError("INVALID_RESPONSE",true);}if(!record(body)||body.jsonrpc!=="2.0"||("error" in body))throw new DevnetRpcError("PROVIDER",true);if(!("result" in body))throw new DevnetRpcError("INVALID_RESPONSE",true);return body.result;}finally{clearTimeout(timer);}}
}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value);
function appendApiKey(endpoint:string,key:string){const parsed=new URL(endpoint);parsed.searchParams.set("api-key",key);return parsed.toString();}
export{record};
