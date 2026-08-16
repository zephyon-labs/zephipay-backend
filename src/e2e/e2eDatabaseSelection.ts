export type E2eDatabaseSelection=Readonly<{connectionString:string;source:"DATABASE_URL"|"TEST_DATABASE_URL"}>;
type Environment=Readonly<Record<string,string|undefined>>;
export function selectE2eDatabase(mode:"LIVE_DEVNET_CANARY"|"OFFLINE",env:Environment):E2eDatabaseSelection{
 const source=mode==="LIVE_DEVNET_CANARY"?"DATABASE_URL":"TEST_DATABASE_URL",connectionString=env[source]?.trim();
 if(!connectionString)throw Object.assign(new Error(`${source} is required for ${mode}.`),{failureStage:"PRECONDITION_FAILED"as const});
 return Object.freeze({connectionString,source});
}
export function sanitizedDatabaseTarget(connectionString:string){let url:URL;try{url=new URL(connectionString);}catch{throw new Error("Selected database URL is invalid.");}if(!["postgres:","postgresql:"].includes(url.protocol)||!url.hostname||!url.pathname.slice(1))throw new Error("Selected database URL must identify PostgreSQL host and database.");return Object.freeze({host:url.hostname,port:url.port||"5432",database:decodeURIComponent(url.pathname.slice(1))});}
