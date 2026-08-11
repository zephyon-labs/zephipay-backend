export const CERTIFICATION_TIERS=Object.freeze({0:"functional",1:"small beta",2:"expanded beta",3:"year-one target",4:"stress"} as const);

export type RunManifest=Readonly<{commit:string;nodeVersion:string;k6Version:string;postgresVersion:string;scenario:string;seed:string;vus:number;arrivalRate:number;duration:string;pool:Record<string,unknown>}>;

export function certificationReport(manifest:RunManifest,summary:Record<string,unknown>,invariants:{passed:boolean;violations:readonly unknown[]}):string{
  const verdict=invariants.passed?"PASS":"FAIL",metrics=(summary.metrics??{}) as Record<string,{count?:number;rate?:number;med?:number;"p(95)"?:number;"p(99)"?:number}>,http=metrics.http_req_duration??{},requests=metrics.http_reqs??{},failures=metrics.r4_request_failures?.count??0;
  return [`# R4 capacity report`,``,`- Verdict: ${verdict}`,
    `- Certification: TIER 0 — functional harness only`,`- Environment: local compiled backend + isolated disposable PostgreSQL + Mock rail`,`- Commit: ${manifest.commit}`,
    `- Scenario: ${manifest.scenario}`,`- VUs: ${manifest.vus}`,`- Arrival rate: ${manifest.arrivalRate} req/s`,
    `- Duration: ${manifest.duration}`,`- Node: ${manifest.nodeVersion}`,`- k6: ${manifest.k6Version}`,
    `- PostgreSQL: ${manifest.postgresVersion}`,`- Runtime pool: ${JSON.stringify(manifest.pool)}`,
    `- HTTP requests: ${requests.count??0}`,`- Measured throughput: ${requests.rate??0} req/s`,`- HTTP failures: ${failures}`,
    `- HTTP p50/p95/p99: ${http.med??"n/a"} / ${http["p(95)"]??"n/a"} / ${http["p(99)"]??"n/a"} ms`,
    `- Economic invariants: ${invariants.passed?"all passed":`${invariants.violations.length} violation(s)`}`,
    `- Bottleneck observed: not assessed during harness-only validation`,`- Next safe stage: Stage 1 (10 VUs) only after explicit capacity-run approval`,
    ``,`## Summary`,``,"```json",JSON.stringify(summary,null,2),"```",``,`No Tier 1+ capacity claim is made by this report.`,``].join("\n");
}
