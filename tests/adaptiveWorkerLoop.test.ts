import assert from "node:assert/strict";
import { test } from "node:test";
import { AdaptiveWorkerLoop } from "../src/executions/adaptiveWorkerLoop";

type Scheduled = { callback: () => void; delay: number; cancelled: boolean };
function harness(outcomes: Array<boolean | Error>) {
  const scheduled: Scheduled[]=[];const observed:Array<{delay:number;outcome:string}>=[];
  const loop=new AdaptiveWorkerLoop(async()=>{const value=outcomes.shift();if(value instanceof Error)throw value;return value??false;},
    (delay,outcome)=>observed.push({delay,outcome}),
    ((callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};scheduled.push(item);return item as any;}) as any,
    ((item:Scheduled)=>{item.cancelled=true;}) as any);
  return {loop,scheduled,observed};
}
async function fire(item:Scheduled){item.callback();await new Promise<void>((resolve)=>setImmediate(resolve));}

test("idle worker polls back off progressively and cap at two seconds",async()=>{const h=harness([false,false,false,false,false,false]);h.loop.start();assert.equal(h.scheduled[0].delay,100);for(let i=0;i<6;i++)await fire(h.scheduled[i]);assert.deepEqual(h.observed.map(x=>x.delay),[250,500,1000,2000,2000,2000]);h.loop.stop();});
test("discovered work resets polling to the fast interval",async()=>{const h=harness([false,false,true]);h.loop.start();await fire(h.scheduled[0]);await fire(h.scheduled[1]);await fire(h.scheduled[2]);assert.deepEqual(h.observed,[{delay:250,outcome:"idle"},{delay:500,outcome:"idle"},{delay:100,outcome:"work"}]);h.loop.stop();});
test("temporary failures back off without a runaway tight loop",async()=>{const h=harness([new Error("temporary"),new Error("temporary")]);h.loop.start();await fire(h.scheduled[0]);await fire(h.scheduled[1]);assert.deepEqual(h.observed,[{delay:250,outcome:"failure"},{delay:500,outcome:"failure"}]);h.loop.stop();});
test("a custom reconciliation cadence applies bounded backoff",async()=>{const scheduled:Scheduled[]=[],observed:number[]=[],loop=new AdaptiveWorkerLoop(async()=>false,(delay)=>observed.push(delay),((callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};scheduled.push(item);return item as any;}) as any,undefined,[1000,2000,5000,10000,30000]);loop.start();for(let index=0;index<6;index++)await fire(scheduled[index]);assert.deepEqual(observed,[2000,5000,10000,30000,30000,30000]);loop.stop();});
test("cadence instrumentation cannot stop polling",async()=>{const scheduled:Scheduled[]=[];const loop=new AdaptiveWorkerLoop(async()=>false,()=>{throw new Error("metrics unavailable");},((callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};scheduled.push(item);return item as any;}) as any);loop.start();await fire(scheduled[0]);assert.equal(scheduled[1].delay,250);loop.stop();});
test("stop cancels pending work and an in-flight stop cannot reschedule",async()=>{let release!:()=>void;const scheduled:Scheduled[]=[];const loop=new AdaptiveWorkerLoop(()=>new Promise<boolean>(resolve=>{release=()=>resolve(false);}),()=>undefined,((callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};scheduled.push(item);return item as any;}) as any,((item:Scheduled)=>{item.cancelled=true;}) as any);loop.start();scheduled[0].callback();loop.stop();release();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(scheduled.length,1);loop.start();loop.stop();assert.equal(scheduled[1].cancelled,true);});
test("stopAndDrain waits for the current iteration without changing cadence",async()=>{let release!:()=>void;const scheduled:Scheduled[]=[];const loop=new AdaptiveWorkerLoop(()=>new Promise<boolean>(resolve=>{release=()=>resolve(true);}),()=>undefined,((callback:()=>void,delay:number)=>{const item={callback,delay,cancelled:false};scheduled.push(item);return item as any;}) as any);loop.start();scheduled[0].callback();let drained=false;const drain=loop.stopAndDrain().then(()=>{drained=true;});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(drained,false);release();await drain;assert.equal(scheduled.length,1);});
