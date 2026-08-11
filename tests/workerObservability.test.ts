import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Mock worker observability boundary",()=>{
  it("records ticks, claim timing, empty/successful claims, outcomes, failures, and adaptive cadence",async()=>{
    const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
    assert.match(source,/new AdaptiveWorkerLoop\(async \(\) =>/);
    assert.match(source,/executionLoop\.start\(\)/);
    assert.match(source,/server\.on\("close",\(\)=>executionLoop\?\.stop\(\)\)/);
    assert.match(source,/recordCounter\("worker\.tick"\)/);
    assert.match(source,/recordTiming\("worker\.operation\.duration"/);
    assert.match(source,/recordCounter\("worker\.claim"/);
    assert.match(source,/outcome:processed\?"claimed":"empty"/);
    assert.match(source,/recordCounter\("worker\.outcome"/);
    assert.match(source,/recordCounter\("worker\.failure"/);
    assert.match(source,/worker_tick_failed/);
    assert.match(source,/recordCounter\("worker\.schedule"/);
    assert.doesNotMatch(source,/queueDepth|pg_stat_activity/);
  });

  it("keeps legacy direct send disabled",async()=>{
    const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
    assert.match(source,/"\/api\/send"/);assert.match(source,/Legacy direct execution is disabled/);
  });
});
