/** Test infrastructure only. No ambient URL, remote Docker context or CI=true fallback. */
import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { atStage, type DiagnosticCode } from "./nativePostgresDiagnostics";
import type { Pool } from "pg";
import {
  nativeDisposableTarget,
  type DisposableTarget,
} from "./nativePostgresSafety";

export const CI_PROFILE = "github-service-v1";
export const CI_IMAGE =
  "postgres:16.15-bookworm@sha256:5983db9a9c6ad225a48a46cfe2e03e6680b1826662befd0465eb05b34cb1c64e";
export const CI_TMPFS = "/var/lib/postgresql/data";
export const CI_TMPFS_OPTIONS = "rw,nosuid,noexec,size=1073741824";
export const CI_ADMIN = "native_session_ci_admin";
export const CI_ADMIN_PASSWORD = "native-session-ci-admin-disposable-only";
type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;
export type CiContext = Readonly<{
  service: string;
  originalService: string;
  network: string;
  sha: string;
  repository: string;
  run: string;
  attempt: string;
}>;
export type CiEvidence = {
  head: string;
  container: unknown;
  image: unknown;
  network: unknown;
};
export type CiIdentity = Readonly<{
  service: string;
  networkId: string;
  imageId: string;
  server: string;
  gateway: string;
}>;
export type Inspect = (context: CiContext) => CiEvidence;
function check(value: unknown): asserts value {
  if (!value)
    throw new Error("Native PostgreSQL CI safety verification failed");
}
function object(value: unknown): Json {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Json;
}
function exactKeys(value: unknown, keys: string[]): Json {
  const result = object(value);
  check(Object.keys(result).sort().join("|") === keys.sort().join("|"));
  return result;
}
function empty(value: unknown) {
  check(value === null || (Array.isArray(value) && value.length === 0));
}
function match(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
const id = /^[0-9a-f]{64}$/;

/** This is corroboration inside a reviewed workflow, not attestation against malicious runner code. */
export function ciContext(
  env: Env,
  platform = process.platform,
  arch = process.arch,
): CiContext {
  check(env.NATIVE_SESSION_TEST_PROFILE === CI_PROFILE);
  check(
    platform === "linux" &&
      arch === "x64" &&
      env.GITHUB_ACTIONS === "true" &&
      env.RUNNER_ENVIRONMENT === "github-hosted" &&
      env.RUNNER_OS === "Linux" &&
      env.RUNNER_ARCH === "X64",
  );
  check(
    env.GITHUB_SERVER_URL === "https://github.com" &&
      env.GITHUB_REPOSITORY === "zephyon-labs/zephipay-backend" &&
      env.GITHUB_REPOSITORY_ID === "1247983326" &&
      env.GITHUB_JOB === "verify" &&
      env.GITHUB_WORKFLOW === "Backend CI",
  );
  check(
    (env.GITHUB_EVENT_NAME === "push" &&
      env.GITHUB_REF === "refs/heads/main") ||
      (env.GITHUB_EVENT_NAME === "pull_request" &&
        match(env.GITHUB_REF, /^refs\/pull\/[1-9][0-9]*\/merge$/)),
  );
  check(
    match(env.GITHUB_SHA, /^[0-9a-f]{40}$/) &&
      match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/) &&
      match(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/),
  );
  check(
    match(env.NATIVE_SESSION_CI_SERVICE_ID, id) &&
      match(env.NATIVE_SESSION_CI_ORIGINAL_SERVICE_ID, id) &&
      env.NATIVE_SESSION_CI_SERVICE_ID !==
        env.NATIVE_SESSION_CI_ORIGINAL_SERVICE_ID &&
      match(env.NATIVE_SESSION_CI_NETWORK, /^github_network_[0-9a-f]{32}$/) &&
      env.NATIVE_SESSION_CI_PORT === "55432",
  );
  for (const [key, value] of Object.entries(env)) {
    if (
      /^(PG|DOCKER_)/.test(key) ||
      /DATABASE_URL$/.test(key) ||
      key === "NODE_OPTIONS"
    )
      check(value === undefined);
  }
  return Object.freeze({
    service: env.NATIVE_SESSION_CI_SERVICE_ID!,
    originalService: env.NATIVE_SESSION_CI_ORIGINAL_SERVICE_ID!,
    network: env.NATIVE_SESSION_CI_NETWORK!,
    sha: env.GITHUB_SHA!,
    repository: env.GITHUB_REPOSITORY_ID!,
    run: env.GITHUB_RUN_ID!,
    attempt: env.GITHUB_RUN_ATTEMPT!,
  });
}

const containerFormat =
  '{"id":{{json .Id}},"imageRef":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"state":STATE_FIELDS,"restarts":{{json .RestartCount}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}},"mounts":{{json .Mounts}},"host":HOST_FIELDS,"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}}}';
const stateFormat =
  '{"Running":{{json .State.Running}},"Paused":{{json .State.Paused}},"Restarting":{{json .State.Restarting}},"Dead":{{json .State.Dead}},"OOMKilled":{{json .State.OOMKilled}},"Status":{{json .State.Status}},"Health":{"Status":{{json .State.Health.Status}}}}';
// Project only reviewed metadata; never inspect Config.Env or health-check logs.
const hostFormat =
  '{"networkMode":{{json .HostConfig.NetworkMode}},"bindings":{{json .HostConfig.PortBindings}},"tmpfs":{{json .HostConfig.Tmpfs}},"binds":{{json .HostConfig.Binds}},"volumesFrom":{{json .HostConfig.VolumesFrom}},"mounts":{{json .HostConfig.Mounts}},"privileged":{{json .HostConfig.Privileged}},"devices":{{json .HostConfig.Devices}},"capAdd":{{json .HostConfig.CapAdd}},"restart":{{json .HostConfig.RestartPolicy}}}';
export function inspectCiMetadata(
  context: CiContext,
  run: (file: string, args: string[]) => string,
): CiEvidence {
  const docker = (args: string[]) =>
    run("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", ...args]);
  const readJson = (
    read: DiagnosticCode,
    parse: DiagnosticCode,
    args: string[],
  ) => {
    const text = atStage(read, () => docker(args));
    return atStage(parse, () => JSON.parse(text));
  };
  const format = containerFormat
    .replace("HOST_FIELDS", hostFormat)
    .replace("STATE_FIELDS", stateFormat);
  const container = readJson(
    "DOCKER_CONTAINER_READ_FAILED",
    "DOCKER_CONTAINER_PARSE_FAILED",
    ["inspect", "--type", "container", "--format", format, context.service],
  );
  return {
    head: atStage("CHECKOUT_READ_FAILED", () =>
      run("/usr/bin/git", ["rev-parse", "HEAD"]),
    ),
    container,
    image: readJson("DOCKER_IMAGE_READ_FAILED", "DOCKER_IMAGE_PARSE_FAILED", [
      "image",
      "inspect",
      "--format",
      '{"id":{{json .Id}},"digests":{{json .RepoDigests}},"os":{{json .Os}},"arch":{{json .Architecture}}}',
      CI_IMAGE,
    ]),
    network: readJson(
      "DOCKER_NETWORK_READ_FAILED",
      "DOCKER_NETWORK_PARSE_FAILED",
      [
        "network",
        "inspect",
        "--format",
        '{"id":{{json .Id}},"name":{{json .Name}},"driver":{{json .Driver}},"scope":{{json .Scope}},"internal":{{json .Internal}},"ipam":{{json .IPAM.Config}},"containers":{{json .Containers}}}',
        context.network,
      ],
    ),
  };
}
export const collectCiEvidence: Inspect = (context) =>
  inspectCiMetadata(context, (file, args) =>
    execFileSync(file, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  );

export function verifyCiEvidence(
  context: CiContext,
  evidence: CiEvidence,
): CiIdentity {
  check(evidence.head === context.sha);
  const c = object(evidence.container),
    image = object(evidence.image),
    network = object(evidence.network);
  check(
    c.id === context.service &&
      c.imageRef === CI_IMAGE &&
      match(c.imageId, /^sha256:[0-9a-f]{64}$/) &&
      image.id === c.imageId,
  );
  check(
    image.os === "linux" &&
      image.arch === "amd64" &&
      Array.isArray(image.digests) &&
      image.digests.includes(`postgres@${CI_IMAGE.split("@")[1]}`),
  );
  const labels = object(c.labels);
  for (const [key, value] of Object.entries({
    "zephyon.native.fixture": CI_PROFILE,
    "zephyon.native.repository": context.repository,
    "zephyon.native.run": context.run,
    "zephyon.native.attempt": context.attempt,
    "zephyon.native.source": context.sha,
  }))
    check(labels[key] === value);
  const state = object(c.state);
  check(
    state.Running === true &&
      state.Paused === false &&
      state.Restarting === false &&
      state.Dead === false &&
      state.OOMKilled === false &&
      state.Status === "running" &&
      object(state.Health).Status === "healthy" &&
      c.restarts === 0,
  );
  check(
    JSON.stringify(c.entrypoint) === '["docker-entrypoint.sh"]' &&
      JSON.stringify(c.cmd) === '["postgres"]',
  );
  const host = object(c.host);
  check(host.networkMode === context.network && host.privileged === false);
  for (const key of ["binds", "volumesFrom", "mounts", "devices", "capAdd"])
    empty(host[key]);
  check(
    object(host.restart).Name === "no" &&
      object(host.restart).MaximumRetryCount === 0,
  );
  check(exactKeys(host.tmpfs, [CI_TMPFS])[CI_TMPFS] === CI_TMPFS_OPTIONS);
  // Docker versions may omit tmpfs from Mounts; configured tmpfs must still be exact.
  // Every reported mount must be that tmpfs: never accept an anonymous/named volume or bind.
  check(Array.isArray(c.mounts) && c.mounts.length <= 1);
  for (const mount of c.mounts) {
    const m = object(mount);
    check(
      m.Type === "tmpfs" &&
        m.Destination === CI_TMPFS &&
        m.RW === true &&
        (m.Source === "" || m.Source === undefined),
    );
  }
  for (const ports of [host.bindings, c.ports]) {
    const mapping = exactKeys(ports, ["5432/tcp"])["5432/tcp"];
    check(Array.isArray(mapping) && mapping.length === 1);
    check(
      object(mapping[0]).HostIp === "127.0.0.1" &&
        object(mapping[0]).HostPort === "55432",
    );
  }
  const endpoint = object(
    exactKeys(c.networks, [context.network])[context.network],
  );
  check(
    match(network.id, id) &&
      network.id === endpoint.NetworkID &&
      network.name === context.network &&
      network.driver === "bridge" &&
      network.scope === "local" &&
      network.internal === false,
  );
  const server = endpoint.IPAddress,
    gateway = endpoint.Gateway;
  check(
    typeof server === "string" &&
      isIP(server) === 4 &&
      typeof gateway === "string" &&
      isIP(gateway) === 4 &&
      server !== gateway,
  );
  check(
    endpoint.GlobalIPv6Address === "" &&
      Number.isInteger(endpoint.IPPrefixLen) &&
      Number(endpoint.IPPrefixLen) >= 16 &&
      Number(endpoint.IPPrefixLen) <= 30,
  );
  check(Array.isArray(network.ipam) && network.ipam.length === 1);
  const ipam = object(network.ipam[0]);
  check(ipam.Gateway === gateway && typeof ipam.Subnet === "string");
  const [base, prefix] = ipam.Subnet.split("/");
  check(isIP(base) === 4 && Number(prefix) === endpoint.IPPrefixLen);
  const ipNumber = (ip: string) =>
    ip.split(".").reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0);
  const mask = (0xffffffff << (32 - Number(prefix))) >>> 0;
  check(
    (ipNumber(server) & mask) >>> 0 === ipNumber(base) &&
      (ipNumber(gateway) & mask) >>> 0 === ipNumber(base),
  );
  const peers = object(network.containers),
    peer = object(peers[context.service]);
  check(
    peer.IPv4Address === `${server}/${prefix}` &&
      peer.EndpointID === endpoint.EndpointID &&
      match(peer.EndpointID, id),
  );
  // Both services belong to this job, but they must be distinct containers/endpoints.
  check(
    object(peers[context.originalService]).IPv4Address !== peer.IPv4Address,
  );
  return Object.freeze({
    service: context.service,
    networkId: network.id as string,
    imageId: image.id as string,
    server,
    gateway,
  });
}

const registrations = new WeakMap<
  DisposableTarget,
  { context: CiContext; identity: CiIdentity; inspect: Inspect }
>();
export function ciDisposableTarget(
  env: Env,
  inspect: Inspect = collectCiEvidence,
): DisposableTarget {
  const context = atStage("CONTEXT_REJECTED", () => ciContext(env));
  const evidence = atStage("DOCKER_METADATA_FAILED", () => inspect(context));
  const identity = atStage("METADATA_REJECTED", () =>
    verifyCiEvidence(context, evidence),
  );
  const target = atStage("TARGET_REJECTED", () => {
    check(
      env.NATIVE_SESSION_TEST_CONFIRM ===
        "DISPOSABLE_GITHUB_NATIVE_SESSION_V1" &&
        env.NATIVE_SESSION_TEST_PORT === "55432",
    );
    return nativeDisposableTarget({
      ...env,
      NATIVE_SESSION_TEST_CONFIRM: "DISPOSABLE_LOCAL_NATIVE_SESSION_V1",
    });
  });
  Object.freeze(target.pool);
  Object.freeze(target);
  registrations.set(target, { context, identity, inspect });
  return target;
}
export function isCiTarget(target: DisposableTarget) {
  return registrations.has(target);
}
function identityFor(target: DisposableTarget) {
  return atStage("SERVICE_RECHECK_FAILED", () => {
    const registration = registrations.get(target);
    check(registration);
    const { context, identity, inspect } = registration;
    const evidence = atStage("DOCKER_METADATA_FAILED", () => inspect(context));
    check(
      JSON.stringify(
        atStage("METADATA_REJECTED", () => verifyCiEvidence(context, evidence)),
      ) === JSON.stringify(identity),
    );
    return identity;
  });
}

export async function verifyCiDatabase(
  pool: Pick<Pool, "query">,
  target: DisposableTarget,
  bootstrap = false,
): Promise<void> {
  const identity = identityFor(target);
  const { rows } =
    await pool.query(`SELECT current_database() AS database, current_user AS username,
    inet_server_addr()::text AS address, inet_server_port() AS port,
    inet_client_addr()::text AS client_address, inet_client_port() AS client_port,
    current_setting('server_version_num')::integer AS version, pg_is_in_recovery() AS recovery,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`);
  check(rows.length === 1);
  const r = object(rows[0]);
  check(
    r.database === (bootstrap ? "postgres" : target.database) &&
      r.username === (bootstrap ? CI_ADMIN : "native_session_fixture") &&
      r.address === identity.server &&
      r.port === 5432 &&
      r.client_address === identity.gateway &&
      typeof r.client_port === "number" &&
      Number.isInteger(r.client_port) &&
      r.client_port > 0 &&
      r.client_port <= 65535 &&
      typeof r.version === "number" &&
      Number.isFinite(r.version) &&
      Number.isInteger(r.version) &&
      r.version === 160015 &&
      r.recovery === false &&
      r.marker === (bootstrap ? null : target.marker),
  );
}
export async function verifyCiEmpty(pool: Pick<Pool, "query">): Promise<void> {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
    (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
    (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) AS count`);
  check(rows.length === 1 && rows[0]?.count === "0");
}
export async function verifyCiDisposable(
  pool: Pick<Pool, "query">,
  target: DisposableTarget,
  emptyTarget: boolean,
): Promise<void> {
  await verifyCiDatabase(pool, target);
  if (emptyTarget) await verifyCiEmpty(pool);
}
