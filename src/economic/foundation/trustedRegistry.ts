import type { Pool, PoolClient } from "pg";
import { AssetIdentityV1, NetworkDomainV1, assertQualifiedAssetV1, createAssetIdentityV1, createNetworkDomainV1, sameNetworkV1 } from "zephyon-protocol";
import { CIRCLE_SOLANA_DEVNET_USDC_MINT, CIRCLE_SOLANA_DEVNET_USDC_DECIMALS } from "../../devnet/canonicalDevnetAsset";
import { audit, machineId, requireCondition, transaction, units } from "./database";

export type RegistryConfiguration = Readonly<{
  network: { id: string; version: string; identity: NetworkDomainV1; effectiveAt: string };
  assets: readonly { id: string; version: string; identity: AssetIdentityV1; role: "PAYMENT" | "FEE"; effectiveAt: string }[];
}>;

/** Explicit server configuration only. No default genesis, RPC, ZERA entry or route registration. */
export function devnetUsdcConfiguration(genesisHash: string, effectiveAt: string): RegistryConfiguration {
  const network = createNetworkDomainV1({ family: "solana", environment: "devnet", genesisHash });
  return {
    network: { id: "solana-devnet-v1", version: "1", identity: network, effectiveAt },
    assets: [
      { id: "devnet-usdc-v1", version: "1", role: "PAYMENT", effectiveAt, identity: createAssetIdentityV1({
        schema: "zephyon.asset/v1", network, kind: "spl-token", decimals: CIRCLE_SOLANA_DEVNET_USDC_DECIMALS,
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mint: CIRCLE_SOLANA_DEVNET_USDC_MINT,
      }) },
      { id: "devnet-sol-fee-v1", version: "1", role: "FEE", effectiveAt, identity: createAssetIdentityV1({
        schema: "zephyon.asset/v1", network, kind: "native", nativeId: "sol", decimals: 9,
      }) },
    ],
  };
}

/** Administrative composition seam; never expose this object or its DB credentials to a request adapter. */
export class TrustedRegistryAdministration {
  constructor(private readonly pool: Pool) {}

  async install(configuration: RegistryConfiguration): Promise<void> {
    const n = configuration.network, network = createNetworkDomainV1(n.identity);
    await transaction(this.pool, async client => {
      await client.query(`INSERT INTO economic_network_registry(registry_id,version,identity,genesis_hash,effective_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT (registry_id) DO NOTHING`, [machineId(n.id), machineId(n.version), network, network.genesisHash, n.effectiveAt]);
      const stored = (await client.query("SELECT * FROM economic_network_registry WHERE registry_id=$1 FOR SHARE", [n.id])).rows[0];
      requireCondition(stored && stored.version === n.version && sameNetworkV1(stored.identity, network) && stored.effective_at.toISOString() === n.effectiveAt && !stored.revoked_at, "Network configuration conflict/revocation.");
      for (const a of configuration.assets) {
        const asset = createAssetIdentityV1(a.identity);
        requireCondition(sameNetworkV1(asset.network, network), "Asset configuration network mismatch.");
        await client.query(`INSERT INTO economic_asset_registry(registry_id,network_id,version,identity,use_role,effective_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (registry_id) DO NOTHING`, [machineId(a.id), n.id, machineId(a.version), asset, a.role, a.effectiveAt]);
        const row = (await client.query("SELECT * FROM economic_asset_registry WHERE registry_id=$1 FOR SHARE", [a.id])).rows[0];
        requireCondition(row && row.version === a.version && row.network_id === n.id && row.use_role === a.role && row.effective_at.toISOString() === a.effectiveAt && !row.revoked_at, "Asset configuration conflict/revocation.");
        assertQualifiedAssetV1(row.identity, asset);
      }
      await audit(client, { type: "REGISTRY_CONFIGURED", actor: "server-configuration", reference: n.id });
    });
  }

  async installBudget(input: { id: string; network: NetworkDomainV1; sponsorPublicKey: string; sponsorKeyVersion: string;
    base: string; priority: string; rent: string; outstanding: number }): Promise<void> {
    requireCondition(Number.isSafeInteger(input.outstanding) && input.outstanding > 0, "Invalid outstanding limit.");
    await transaction(this.pool, async client => {
      await qualifiedNetwork(client, input.network, new Date().toISOString());
      await client.query(`INSERT INTO economic_sponsor_budgets(budget_id,network,sponsor_public_key,sponsor_key_version,base_limit,priority_limit,rent_limit,outstanding_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [machineId(input.id), createNetworkDomainV1(input.network), machineId(input.sponsorPublicKey), machineId(input.sponsorKeyVersion), units(input.base), units(input.priority), units(input.rent), input.outstanding]);
      await client.query(`INSERT INTO economic_budget_heads(family_id,network,sponsor_public_key,sponsor_key_version,current_budget_id) VALUES($1,$2,$3,$4,$1)`,[input.id,createNetworkDomainV1(input.network),input.sponsorPublicKey,input.sponsorKeyVersion]);
      await client.query("INSERT INTO economic_budget_versions(budget_id,family_id,version) VALUES($1,$1,1)",[input.id]);
      await audit(client, { type: "BUDGET_CONFIGURED", actor: "server-configuration", reference: input.id });
    });
  }

  /** CAS revision prevents stale administration from reviving disabled budgets or overwriting a newer version. */
  async setBudgetStatus(familyId: string, expectedRevision: string, status: "ACTIVE" | "DISABLED"): Promise<void> {
    requireCondition(status === "ACTIVE" || status === "DISABLED", "Invalid budget status.");
    await transaction(this.pool, async client => {
      const head = (await client.query("SELECT * FROM economic_budget_heads WHERE family_id=$1 FOR UPDATE",[machineId(familyId)])).rows[0];
      requireCondition(head && head.revision === expectedRevision, "Stale budget administrative revision.");
      if (head.status === status) return;
      await client.query("UPDATE economic_budget_heads SET status=$2,revision=revision+1 WHERE family_id=$1",[familyId,status]);
      await audit(client,{type:`BUDGET_${status}`,actor:"budget-administration",reference:`${familyId}:${BigInt(head.revision)+1n}`});
    });
  }

  async reviseBudget(input: { familyId: string; expectedRevision: string; newBudgetId: string; base: string; priority: string; rent: string; outstanding: number }): Promise<void> {
    requireCondition(Number.isSafeInteger(input.outstanding) && input.outstanding > 0,"Invalid outstanding limit.");
    await transaction(this.pool, async client => {
      const head = (await client.query("SELECT * FROM economic_budget_heads WHERE family_id=$1 FOR UPDATE",[machineId(input.familyId)])).rows[0];
      requireCondition(head && head.revision === input.expectedRevision,"Stale budget administrative revision.");
      const next = (await client.query("SELECT (max(version)+1)::text AS version FROM economic_budget_versions WHERE family_id=$1",[input.familyId])).rows[0].version;
      await client.query(`INSERT INTO economic_sponsor_budgets(budget_id,network,sponsor_public_key,sponsor_key_version,base_limit,priority_limit,rent_limit,outstanding_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[machineId(input.newBudgetId),head.network,head.sponsor_public_key,head.sponsor_key_version,units(input.base),units(input.priority),units(input.rent),input.outstanding]);
      await client.query("INSERT INTO economic_budget_versions(budget_id,family_id,version) VALUES($1,$2,$3)",[input.newBudgetId,input.familyId,next]);
      await client.query("UPDATE economic_budget_heads SET current_budget_id=$2,revision=revision+1 WHERE family_id=$1",[input.familyId,input.newBudgetId]);
      await audit(client,{type:"BUDGET_VERSION_CREATED",actor:"budget-administration",reference:`${input.newBudgetId}:${next}`});
    });
  }

  async revoke(kind: "network" | "asset", id: string): Promise<void> {
    const table = kind === "network" ? "economic_network_registry" : "economic_asset_registry";
    await transaction(this.pool, async client => {
      const row = (await client.query(`SELECT * FROM ${table} WHERE registry_id=$1 FOR UPDATE`, [id])).rows[0];
      requireCondition(row, "Registry record missing.");
      if (!row.revoked_at) await client.query(`UPDATE ${table} SET revoked_at=GREATEST(clock_timestamp(),effective_at) WHERE registry_id=$1`, [id]);
      await audit(client, { type: "REGISTRY_REVOKED", actor: "server-configuration", reference: id });
    });
  }
}

async function qualifiedNetwork(client: PoolClient, candidate: NetworkDomainV1, now: string): Promise<string> {
  const network = createNetworkDomainV1(candidate);
  const row = (await client.query(`SELECT * FROM economic_network_registry WHERE identity=$1::jsonb FOR SHARE`, [network])).rows[0];
  requireCondition(row && !row.revoked_at && row.effective_at.toISOString() <= now, "Network unqualified, ineffective or revoked.");
  return row.registry_id;
}

/** Caller supplies a candidate, never a trusted definition. Locks survive the enclosing eligibility transaction. */
export async function qualifyAsset(client: PoolClient, candidate: AssetIdentityV1, role: "PAYMENT" | "FEE", now: string): Promise<string> {
  const asset = createAssetIdentityV1(candidate), networkId = await qualifiedNetwork(client, asset.network, now);
  const row = (await client.query(`SELECT * FROM economic_asset_registry WHERE identity=$1::jsonb AND use_role=$2 AND network_id=$3 FOR SHARE`, [asset, role, networkId])).rows[0];
  requireCondition(row && !row.revoked_at && row.effective_at.toISOString() <= now, "Asset unqualified, ineffective or revoked.");
  assertQualifiedAssetV1(asset, row.identity);
  return row.registry_id;
}
