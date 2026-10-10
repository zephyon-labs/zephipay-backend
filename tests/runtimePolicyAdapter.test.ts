import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runtimeRequest } from "../src/economic/runtime/runtimeRequest";
import { runtimeSources, runtimeTestProfile } from "../src/economic/runtime/runtimeTestProfile";
import { readyFixture } from "./helpers/realProviderFixtures";

test("Runtime request admits references only, never caller evidence, policy, clock or approval",()=>{
  const request={paymentId:randomUUID(),accountSessionId:randomUUID(),consentId:randomUUID(),envelopeDigest:"ab".repeat(32)};
  assert.deepEqual(runtimeRequest(request),request);
  for(const key of ["evidence","qualifiedEvidence","policy","evaluatedAt","decision","result","configurationFingerprint"])
    assert.throws(()=>runtimeRequest({...request,[key]:"APPROVED"}),/fields/);
  for(const key of Object.keys(request)) assert.throws(()=>runtimeRequest({...request,[key]:"bad-reference"}),/reference/);
});
test("Runtime TEST profile requires verified configuration, exact Devnet asset and explicit cap",async()=>{
  const f=await readyFixture(), asset=JSON.parse(readFileSync("tests/fixtures/economic-intent-v1.json","utf8")).qualifiedAsset;
  const input={qualifiedAsset:asset,policyVersion:"runtime-test-1",effectiveFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2027-01-01T00:00:00.000Z",maxAtomicUnits:"1000000"};
  const p=runtimeTestProfile(f.configuration,input);
  assert.equal(p.configurationFingerprint,f.configuration.fingerprint);
  assert.equal(p.scope,"devnet-test-only");assert.equal(p.assets[0].maxAtomicUnits,"1000000");
  assert.deepEqual(p.requiredEvidence.map(v=>v.sourceId).sort(),Object.values(runtimeSources).map(v=>v.id).sort());
  assert.throws(()=>runtimeTestProfile(structuredClone(f.configuration),input),/Authenticated deployment/);
  assert.throws(()=>runtimeTestProfile(f.configuration,{...input,maxAtomicUnits:"0"}));
  assert.throws(()=>runtimeTestProfile(f.configuration,{...input,qualifiedAsset:{...asset,network:{...asset.network,environment:"mainnet"}}}));
});
