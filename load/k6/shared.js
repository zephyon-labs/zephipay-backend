import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import execution from "k6/execution";

export const requestFailures=new Counter("r4_request_failures");
export const status2xx=new Counter("r4_http_status_2xx"),status4xx=new Counter("r4_http_status_4xx"),status5xx=new Counter("r4_http_status_5xx");
export const workflowDuration=new Trend("r4_workflow_duration",true);
export const base=__ENV.BASE_URL;
export const principals=JSON.parse(open(__ENV.PRINCIPALS_FILE));
export function principal(){return principals[execution.scenario.iterationInTest%principals.length];}
export function headers(token,extra={}){return {Authorization:`Bearer ${token}`,"X-Request-Id":`r4-${__VU}-${__ITER}`,...extra};}
export function recordStatus(response){if(response.status>=200&&response.status<300)status2xx.add(1);else if(response.status>=400&&response.status<500)status4xx.add(1);else if(response.status>=500)status5xx.add(1);return response;}
export function expect(response,status,name){recordStatus(response);const ok=check(response,{[`${name} status ${status}`]:r=>r.status===status});if(!ok)requestFailures.add(1,{route:name,status:String(response.status)});return response;}
export function get(path,token,tag){return expect(http.get(`${base}${path}`,{headers:headers(token),tags:{route:tag}}),200,tag);}
const vus=Number(__ENV.VUS||1),duration=__ENV.DURATION||"3s";
export const smokeOptions={scenarios:{workload:__ENV.EXECUTOR==="constant-vus"?{executor:"constant-vus",vus,duration}:{executor:"constant-arrival-rate",rate:Number(__ENV.RPS||1),timeUnit:"1s",duration,preAllocatedVUs:vus,maxVUs:vus}},summaryTrendStats:["avg","min","med","max","p(90)","p(95)","p(99)"],thresholds:{checks:["rate==1"],r4_request_failures:["count==0"],dropped_iterations:["count==0"]}};
