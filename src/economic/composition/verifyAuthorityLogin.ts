import type { Pool } from "pg";
import { authorityPrivilegePolicy, EconomicAuthorityRole } from "./authorityPrivilegePolicy";

type TablePolicy = Record<string, Record<string, readonly string[]>>;
/** Read-only catalog verification under the ACTUAL login; no SET ROLE, DDL or privileged fallback. */
export async function verifyAuthorityLogin(pool: Pool, role: EconomicAuthorityRole, options: { syntheticFixtures?: boolean } = {}): Promise<{ login: string; role: EconomicAuthorityRole }> {
  const expected = authorityPrivilegePolicy[role];
  if (!expected) throw new Error("Unknown economic authority role.");
  const client = await pool.connect(), problems: string[] = [];
  try {
    const identity = (await client.query(`SELECT current_user AS login,session_user AS session,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (!identity.rolcanlogin || identity.login !== identity.session || [identity.rolsuper,identity.rolcreatedb,identity.rolcreaterole,identity.rolreplication,identity.rolbypassrls,identity.database_create].some(Boolean)) problems.push("unsafe login attributes or effective identity");
    const membership = (await client.query(`WITH RECURSIVE memberships(oid) AS (
      SELECT roleid FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=session_user)
      UNION SELECT m.roleid FROM pg_auth_members m JOIN memberships p ON m.member=p.oid)
      SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE oid IN (SELECT oid FROM memberships)`)).rows;
    if (membership.length !== 1 || membership[0].rolname !== `zephipay_economic_${role}` || membership.some(r=>[r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls].some(Boolean))) problems.push("unexpected inherited role or missing intended group");
    const schemas = (await client.query(`SELECT nspname,pg_has_role(current_user,nspowner,'MEMBER') AS owner,has_schema_privilege(current_user,oid,'CREATE') AS can_create
      FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'`)).rows;
    if (schemas.some(s=>s.owner || s.can_create)) problems.push("schema ownership or CREATE privilege");
    if ((await client.query("SELECT pg_has_role(current_user,datdba,'MEMBER') AS owner FROM pg_database WHERE datname=current_database()")).rows[0].owner) problems.push("database ownership");
    const tables:TablePolicy = {...expected.tables};
    if(options.syntheticFixtures) {
      if(role==="signer") { tables["economic_synthetic.signer_plans"]={SELECT:["*"]};tables["economic_synthetic.signer_operations"]={SELECT:["*"],INSERT:["*"]}; }
      if(role==="observer") tables["economic_synthetic.observer_plans"]={SELECT:["*"]};
    }
    const columns = (await client.query(`SELECT CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END AS relname,a.attname,pg_has_role(current_user,c.relowner,'MEMBER') AS owner,
      has_column_privilege(current_user,c.oid,a.attnum,'SELECT') AS s,has_column_privilege(current_user,c.oid,a.attnum,'INSERT') AS i,
      has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') AS u,has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES') AS r,
      has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR has_table_privilege(current_user,c.oid,'TRIGGER') AS forbidden,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee=0) OR
      EXISTS(SELECT 1 FROM aclexplode(a.attacl) x WHERE x.grantee=0) AS public_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped LIMIT 20001`)).rows;
    if (columns.length>20000) problems.push("catalog verification bound exceeded");
    const seen = new Set<string>();
    for (const c of columns) {
      seen.add(c.relname);
      if (c.owner || c.forbidden || c.public_grant) problems.push(`unsafe ownership/write/PUBLIC privilege: ${c.relname}`);
      for (const [name,key] of [["SELECT","s"],["INSERT","i"],["UPDATE","u"],["REFERENCES","r"]] as const) {
        const allowed=tables[c.relname]?.[name] ?? [];
        if (c[key] !== (allowed.includes("*") || allowed.includes(c.attname))) problems.push(`grant mismatch: ${c.relname}.${c.attname}:${name}`);
      }
    }
    for (const table of Object.keys(tables)) if (!seen.has(table)) problems.push(`required table missing: ${table}`);
    const functions = (await client.query(`SELECT p.oid::regprocedure::text AS signature,p.proname,p.prosecdef,
      pg_has_role(current_user,p.proowner,'MEMBER') AS owner,has_function_privilege(current_user,p.oid,'EXECUTE') AS executable,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee=0 AND x.privilege_type='EXECUTE') AS public_execute,
      p.proconfig,owner.rolname AS owner_name
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles owner ON owner.oid=p.proowner
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND ((n.nspname='public' AND p.proname LIKE 'economic_%') OR p.prosecdef)`)).rows;
    const required = new Set<string>(expected.functions);
    for (const f of functions) {
      const signature = f.signature.replace(/^public\./,"");
      if (f.owner || f.public_execute || f.executable !== required.has(signature)) problems.push(`function authority mismatch: ${signature}`);
      if (f.prosecdef && (f.owner_name !== "zephipay_economic_admin" || !f.proconfig?.some((s:string)=>/^search_path=pg_catalog, ?public, ?pg_temp$/.test(s)))) problems.push(`unsafe definer configuration: ${signature}`);
      required.delete(signature);
    }
    for (const name of required) problems.push(`required function missing: ${name}`);
    const sequences=expected.sequences as TablePolicy, remainingSequences=new Set(Object.keys(sequences));
    for(const s of (await client.query(`SELECT CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END AS relname,has_sequence_privilege(current_user,c.oid,'USAGE') AS usage,
      has_sequence_privilege(current_user,c.oid,'SELECT') OR has_sequence_privilege(current_user,c.oid,'UPDATE') AS other,
      pg_has_role(current_user,c.relowner,'MEMBER') AS owner,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) a WHERE a.grantee=0) AS public_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind='S'`)).rows) {
      remainingSequences.delete(s.relname);
      if(s.usage!==Boolean(sequences[s.relname]?.USAGE) || s.other || s.owner || s.public_grant) problems.push(`sequence authority mismatch: ${s.relname}`);
    }
    for(const sequence of remainingSequences) problems.push(`required sequence missing: ${sequence}`);
    if (problems.length) throw new Error(`Economic ACL readiness failed: ${[...new Set(problems)].slice(0,12).join("; ")}`);
    return { login:identity.login, role };
  } finally { client.release(); }
}
