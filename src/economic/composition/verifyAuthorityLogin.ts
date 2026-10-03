import type { Pool, PoolClient } from "pg";
import { authorityPrivilegePolicy, EconomicAuthorityRole } from "./authorityPrivilegePolicy";

export type DeploymentExpectation = Readonly<{ deploymentId: string; environment: string; databaseName: string; login: string; credentialGeneration: string; schemaOwner: string; identityOwner: string }>;

/** Same check can run on the operation connection after waits; there is no admin fallback. */
export async function assertDeploymentConnection(client: PoolClient, role: EconomicAuthorityRole, expected: DeploymentExpectation): Promise<void> {
  const result = (await client.query(`SELECT current_database() AS database_name,current_user AS login,session_user AS session,
    d.deployment_id,d.environment,d.database_name AS registered_database,l.login_name,l.credential_generation
    FROM economic_deployment_identity d JOIN economic_deployment_logins l ON l.authority_role=$1 WHERE d.singleton`, [role])).rows;
  const row=result[0];
  if(result.length!==1 || row.deployment_id!==expected.deploymentId || row.environment!==expected.environment ||
    row.database_name!==expected.databaseName || row.registered_database!==expected.databaseName ||
    row.login!==expected.login || row.session!==expected.login || row.login_name!==expected.login ||
    String(row.credential_generation)!==expected.credentialGeneration)
    throw new Error("Economic deployment identity or credential generation mismatch.");
}

type TablePolicy = Record<string, Record<string, readonly string[]>>;
/** Read-only catalog verification under the ACTUAL login; no SET ROLE, DDL or privileged fallback. */
export async function verifyAuthorityLogin(pool: Pool, role: EconomicAuthorityRole, options: { syntheticFixtures?: boolean; deployment?: DeploymentExpectation } = {}): Promise<{ login: string; role: EconomicAuthorityRole }> {
  const expected = authorityPrivilegePolicy[role];
  if (!expected) throw new Error("Unknown economic authority role.");
  const client = await pool.connect(), problems: string[] = [];
  try {
    if(options.deployment) await assertDeploymentConnection(client,role,options.deployment);
    const identity = (await client.query(`SELECT current_user AS login,session_user AS session,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!identity.rolcanlogin || identity.login !== identity.session || [identity.rolsuper,identity.rolcreatedb,identity.rolcreaterole,identity.rolreplication,identity.rolbypassrls,identity.database_create].some(Boolean)) problems.push("unsafe login attributes or effective identity");
    const membership = (await client.query(`WITH RECURSIVE memberships(oid) AS (
      SELECT roleid FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user)
      UNION SELECT m.roleid FROM pg_auth_members m JOIN memberships p ON m.member=p.oid)
      SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE oid IN (SELECT oid FROM memberships)`)).rows;
    if (membership.length !== 1 || membership[0].rolname !== `zephipay_economic_${role}` || membership.some(r=>[r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls].some(Boolean))) problems.push("unexpected inherited role or missing intended group");
    if((await client.query("SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND admin_option")).rowCount) problems.push("role administration privilege");
    const schemas = (await client.query(`SELECT nspname,pg_get_userbyid(nspowner) AS owner_name,pg_has_role(current_user,nspowner,'MEMBER') AS owner,has_schema_privilege(current_user,oid,'CREATE') AS can_create,has_schema_privilege(current_user,oid,'USAGE WITH GRANT OPTION') AS grantable
      FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'`)).rows;
    if(options.deployment && schemas.some(s=>s.grantable)) problems.push("schema grant option");
    if(options.deployment && !schemas.some(s=>s.nspname==="public" && s.owner_name===options.deployment!.schemaOwner)) problems.push("deployment schema ownership mismatch");
    if (schemas.some(s=>s.owner || s.can_create)) problems.push("schema ownership or CREATE privilege");
    if ((await client.query("SELECT pg_has_role(current_user,datdba,'MEMBER') AS owner FROM pg_database WHERE datname=current_database()")).rows[0].owner) problems.push("database ownership");
    const tables:TablePolicy = {...expected.tables,
      economic_deployment_identity:{SELECT:["*"]},economic_deployment_logins:{SELECT:["*"]}};
    if(role==="identity" || role==="issuer") tables.economic_provider_token_uses={SELECT:["*"],INSERT:["*"]};
    if(options.syntheticFixtures) {
      if(role==="signer") { tables["economic_synthetic.signer_plans"]={SELECT:["*"]};tables["economic_synthetic.signer_operations"]={SELECT:["*"],INSERT:["*"]}; }
      if(role==="observer") tables["economic_synthetic.observer_plans"]={SELECT:["*"]};
    }
    // Policy names are fixed identifiers. Keep actual catalog schema/name pairs separate so a
    // quoted public name containing a dot cannot impersonate an allowed relation in another schema.
    const relationKey=(schema:string,name:string)=>JSON.stringify([schema,name]);
    const tablePolicies=new Map(Object.entries(tables).map(([name,policy])=>{
      const dot=name.indexOf(".");return [relationKey(dot<0?"public":name.slice(0,dot),dot<0?name:name.slice(dot+1)),policy] as const;
    }));
    // Current database, every non-system schema; no foreign data is read. A zero-column relation
    // retains one inventory row so ownership and table/PUBLIC grants cannot disappear from the scan.
    const columns = (await client.query(`SELECT n.nspname AS schema_name,c.relname AS relation_name,format('%I.%I',n.nspname,c.relname) AS relname,a.attname,pg_get_userbyid(c.relowner) AS owner_name,pg_has_role(current_user,c.relowner,'MEMBER') AS owner,
      CASE WHEN a.attnum IS NULL THEN has_table_privilege(current_user,c.oid,'SELECT') ELSE has_column_privilege(current_user,c.oid,a.attnum,'SELECT') END AS s,
      CASE WHEN a.attnum IS NULL THEN has_table_privilege(current_user,c.oid,'INSERT') ELSE has_column_privilege(current_user,c.oid,a.attnum,'INSERT') END AS i,
      CASE WHEN a.attnum IS NULL THEN has_table_privilege(current_user,c.oid,'UPDATE') ELSE has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') END AS u,
      CASE WHEN a.attnum IS NULL THEN has_table_privilege(current_user,c.oid,'REFERENCES') ELSE has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES') END AS r,
      has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'TRIGGER') AS forbidden,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee=0) OR
      EXISTS(SELECT 1 FROM aclexplode(a.attacl) x WHERE x.grantee=0) AS public_grant,
      has_table_privilege(current_user,c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') OR
      CASE WHEN a.attnum IS NULL THEN false ELSE has_column_privilege(current_user,c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') END AS grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f') LIMIT 20001`)).rows;
    if (columns.length>20000) problems.push("catalog verification bound exceeded");
    const seen = new Set<string>();
    for (const c of columns) {
      const qualified=relationKey(c.schema_name,c.relation_name);seen.add(qualified);
      if(options.deployment && tablePolicies.has(qualified)) {
        const owner=c.schema_name==="public" && ["accounts","external_identities","account_sessions","account_security_events"].includes(c.relation_name)
          ? options.deployment.identityOwner : "zephipay_economic_admin";
        if(c.schema_name!=="economic_synthetic" && c.owner_name!==owner) problems.push(`deployment table ownership mismatch: ${c.relname}`);
      }
      if(options.deployment && c.grantable) problems.push(`table/column grant option: ${c.relname}`);
      if (c.owner || c.forbidden || c.public_grant) problems.push(`unsafe ownership/write/PUBLIC privilege: ${c.relname}`);
      for (const [name,key] of [["SELECT","s"],["INSERT","i"],["UPDATE","u"],["REFERENCES","r"]] as const) {
        const allowed=tablePolicies.get(qualified)?.[name] ?? [];
        if (c[key] !== (allowed.includes("*") || allowed.includes(c.attname))) problems.push(`grant mismatch: ${c.relname}.${c.attname}:${name}`);
      }
    }
    for (const table of tablePolicies.keys()) if (!seen.has(table)) problems.push(`required table missing: ${table}`);
    const functions = (await client.query(`SELECT p.oid::regprocedure::text AS signature,p.proname,p.prosecdef,
      pg_has_role(current_user,p.proowner,'MEMBER') AS owner,has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') AS public_execute,
      p.proconfig,owner.rolname AS owner_name,has_function_privilege(current_user,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND ((n.nspname='public' AND p.proname LIKE 'economic_%') OR p.prosecdef)`)).rows;
    const required = new Set<string>(expected.functions);
    for (const f of functions) {
      const signature = f.signature.replace(/^public\./,"");
      if(options.deployment && f.grantable) problems.push(`function grant option: ${signature}`);
      if (f.owner || f.public_execute || f.executable !== required.has(signature)) problems.push(`function authority mismatch: ${signature}`);
      if(options.deployment && signature.startsWith("economic_") && f.owner_name!=="zephipay_economic_admin") problems.push(`deployment function ownership mismatch: ${signature}`);
      if (f.prosecdef && (f.owner_name !== "zephipay_economic_admin" || !f.proconfig?.some((s:string)=>/^search_path=pg_catalog, ?public, ?pg_temp$/.test(s)))) problems.push(`unsafe definer configuration: ${signature}`);
      required.delete(signature);
    }
    for (const name of required) problems.push(`required function missing: ${name}`);
    const sequences=expected.sequences as TablePolicy, remainingSequences=new Set(Object.keys(sequences));
    for(const s of (await client.query(`SELECT CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END AS relname,has_sequence_privilege(current_user,c.oid,'USAGE') AS usage,
      has_sequence_privilege(current_user,c.oid,'SELECT') OR has_sequence_privilege(current_user,c.oid,'UPDATE') AS other,has_sequence_privilege(current_user,c.oid,'USAGE WITH GRANT OPTION') AS grantable,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owner,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a WHERE a.grantee=0) AS public_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind='S'`)).rows) {
      remainingSequences.delete(s.relname);
      if(options.deployment && s.grantable) problems.push(`sequence grant option: ${s.relname}`);
      if(s.usage!==Boolean(sequences[s.relname]?.USAGE) || s.other || s.owner || s.public_grant) problems.push(`sequence authority mismatch: ${s.relname}`);
    }
    for(const sequence of remainingSequences) problems.push(`required sequence missing: ${sequence}`);
    if (problems.length) throw new Error(`Economic ACL readiness failed: ${[...new Set(problems)].slice(0,12).join("; ")}`);
    return { login:identity.login, role };
  } finally { client.release(); }
}
