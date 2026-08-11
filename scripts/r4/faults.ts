import type { Pool, PoolClient } from "pg";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const exec=promisify(execFile);

export async function saturatePool(pool: Pool):Promise<Readonly<{release():void}>>{
  const clients:PoolClient[]=[];
  try{for(let i=0;i<pool.options.max;i++)clients.push(await pool.connect());}
  catch(error){clients.forEach(client=>client.release());throw error;}
  return Object.freeze({release:()=>clients.splice(0).forEach(client=>client.release())});
}

export async function holdAdvisoryLock(pool:Pool,key:number):Promise<Readonly<{release():Promise<void>}>>{
  const client=await pool.connect();await client.query("SELECT pg_advisory_lock($1)",[key]);
  return Object.freeze({release:async()=>{try{await client.query("SELECT pg_advisory_unlock($1)",[key]);}finally{client.release();}}});
}

export async function holdPaymentRowLock(pool:Pool,paymentIntentId:string):Promise<Readonly<{release():Promise<void>}>>{
  const client=await pool.connect();await client.query("BEGIN");await client.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE",[paymentIntentId]);
  return Object.freeze({release:async()=>{try{await client.query("ROLLBACK");}finally{client.release();}}});
}

export async function triggerStatementTimeout(pool:Pool,timeoutMs=25):Promise<void>{
  const client=await pool.connect();try{await client.query("BEGIN");await client.query(`SET LOCAL statement_timeout = '${Math.max(1,Math.floor(timeoutMs))}ms'`);await client.query("SELECT pg_sleep(1)");}finally{await client.query("ROLLBACK").catch(()=>undefined);client.release();}
}

export function transientFailure<T extends object>(target:T,method:keyof T,times=1):T{
  let remaining=times;return new Proxy(target,{get(value,key,receiver){const candidate=Reflect.get(value,key,receiver);if(key!==method||typeof candidate!=="function")return candidate;return(...args:unknown[])=>{if(remaining-->0)return Promise.reject(new Error("R4 deterministic transient failure"));return candidate.apply(value,args);};}});
}

export async function controlDisposableDatabase(container:string,action:"pause"|"unpause"|"stop"):Promise<void>{
  if(!/^zephipay-r4-[a-z0-9-]+$/.test(container))throw new Error("Database fault target must be an R4 disposable container.");
  await exec("docker",[action,container]);
}

export function signalGracefulShutdown(child:Pick<ChildProcess,"kill">):void{if(!child.kill("SIGTERM"))throw new Error("R4 child process was not running.");}
export async function readinessStatus(baseUrl:string):Promise<number>{return (await fetch(`${baseUrl}/health/ready`)).status;}
