import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { createControlledDevnetTestPolicyV1, runtimePolicyProfileDigestV1, type AssetIdentityV1, type RuntimePolicyProfileV1 } from "zephyon-protocol";
import { databaseTime, requireCondition, transaction } from "../foundation/database";
import { qualifyAsset } from "../foundation/trustedRegistry";
import { assertVerifiedDeployment, type VerifiedDeployment } from "../readiness/deploymentProfile";

// These identify actual Backend records, not provider claims or invented KYC/risk scores.
export const runtimeSources = Object.freeze({
  consent: Object.freeze({id:"zephipay:guarded-confirmation",version:"1"}),
  eligibility: Object.freeze({id:"zephipay:canonical-session",version:"1"}),
  destination: Object.freeze({id:"zephipay:prepared-direct-wallet",version:"1"}),
});
export type RuntimeTestProfileInput = Readonly<{
  qualifiedAsset: AssetIdentityV1; policyVersion: string; effectiveFrom: string; expiresAt: string; maxAtomicUnits: string;
}>;
export function runtimeTestProfile(deployment: VerifiedDeployment, input: RuntimeTestProfileInput): RuntimePolicyProfileV1 {
  assertVerifiedDeployment(deployment);
  return createControlledDevnetTestPolicyV1({...input, configurationVersion:String(deployment.profile.revision),
    configurationFingerprint:deployment.fingerprint, sources:runtimeSources});
}
/** Offline administrator only. Register BEFORE preparation/consent; never repair an existing envelope's reference.
 * No defaults, automatic registration, production policy or deployment configuration change.
 */
export async function registerRuntimeTestProfile(pool: Pool, deployment: VerifiedDeployment, input: RuntimeTestProfileInput) {
  const profile=runtimeTestProfile(deployment,input), profileDigest=runtimePolicyProfileDigestV1(profile);
  await transaction(pool,async client=>{
    await qualifyAsset(client,input.qualifiedAsset,"PAYMENT",await databaseTime(client));
    await client.query(`INSERT INTO economic_runtime_test_profiles(profile_digest,deployment_id,profile) VALUES($1,$2,$3)
      ON CONFLICT(profile_digest) DO NOTHING`,[profileDigest,deployment.profile.deploymentId,profile]);
    await client.query(`INSERT INTO economic_runtime_policy_heads(deployment_id,profile_digest) VALUES($1,$2)
      ON CONFLICT(deployment_id) DO UPDATE SET profile_digest=EXCLUDED.profile_digest`,[deployment.profile.deploymentId,profileDigest]);
  });
  return {profile,profileDigest};
}
export async function loadRuntimeTestProfile(client: PoolClient, deployment: VerifiedDeployment, profileDigest: string) {
  const head=(await client.query("SELECT * FROM economic_runtime_policy_heads WHERE deployment_id=$1 FOR SHARE",[deployment.profile.deploymentId])).rows[0];
  const row=(await client.query("SELECT * FROM economic_runtime_test_profiles WHERE profile_digest=$1",[profileDigest])).rows[0];
  requireCondition(row?.deployment_id===deployment.profile.deploymentId,"Unregistered Runtime TEST profile.");
  const p=row.profile as RuntimePolicyProfileV1;
  const profile=runtimeTestProfile(deployment,{qualifiedAsset:p.assets[0].asset,policyVersion:p.policyVersion,
    effectiveFrom:p.effectiveFrom,expiresAt:p.expiresAt,maxAtomicUnits:p.assets[0].maxAtomicUnits});
  requireCondition(isDeepStrictEqual(profile,p) && runtimePolicyProfileDigestV1(profile)===profileDigest,"Runtime profile/configuration mismatch.");
  return {profile,current:head?.profile_digest===profileDigest};
}
