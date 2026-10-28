import http from "node:http";

import type { ProbeContext, ProbeResult } from "../contract";
import type { DockerConfig } from "../specs/docker";
import { elapsedSince, refusesPrivate } from "./guard";

/**
 * One container inspect, over the Docker Engine API.
 *
 * No dependency. `GET /containers/<name>/json` is a plain HTTP request,
 * and `http.request` speaks it over a unix socket via `socketPath` just
 * as happily as over TCP — which is all dockerode would be doing here,
 * for a few megabytes and a native-ish install step in an image that
 * deliberately carries neither.
 *
 * The path is unversioned on purpose. Pinning `/v1.41/` would 400
 * against any daemon older than that, and the two fields this reads have
 * been in the response since the API was called v1.
 */

/** A container inspect is a few KB; an operator-supplied endpoint is not. */
const MAX_BODY_BYTES = 256 * 1024;

/** The daemon's plaintext TCP port, when a `tcp://` address omits one. */
const DEFAULT_TCP_PORT = 2375;

interface InspectResponse {
  Id?: string;
  State?: {
    Running?: boolean;
    Status?: string;
    Health?: { Status?: string };
  };
  RestartCount?: number;
}

type Daemon =
  | { kind: "socket"; socketPath: string }
  | { kind: "tcp"; host: string; port: number };

/**
 * Where the daemon lives, from the one setting that holds it. Exported
 * because the transport choice — and therefore whether the SSRF guard
 * runs at all — is decided entirely here.
 */
export function parseDaemon(address: string): Daemon | null {
  if (!/^(?:tcp|http):\/\//i.test(address)) {
    return { kind: "socket", socketPath: address };
  }
  try {
    const url = new URL(address.replace(/^tcp:/i, "http:"));
    // `URL` keeps an IPv6 literal in its brackets; `net.connect` and
    // `dns.lookup` both want it bare.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host.length === 0) return null;
    return {
      kind: "tcp",
      host,
      port: url.port.length > 0 ? Number(url.port) : DEFAULT_TCP_PORT,
    };
  } catch {
    return null;
  }
}

export async function dockerProbe(
  ctx: ProbeContext<DockerConfig>,
): Promise<ProbeResult> {
  const { containerName, socketPath } = ctx.config;
  if (containerName === null) {
    return unavailable("No container is configured for this monitor.", null);
  }

  const daemon = parseDaemon(socketPath);
  if (daemon === null) {
    return unavailable(`Unreadable Docker daemon address: ${socketPath}`, null);
  }

  // The private-address guard runs only over TCP, and this is the
  // exception that will read like a bug later, so: a unix socket has no
  // host to resolve and no packet that could leave the machine, and the
  // guard's own subject — `ctx.target` — is a label in that case. Worse,
  // the guard would reject it, because the one daemon everybody monitors
  // is the local one and every name for it resolves to a loopback or
  // private address. The default configuration would be unusable.
  //
  // Over TCP the guard is on the daemon host rather than on `ctx.target`.
  // The target is not what gets dialled here, and guarding a host we
  // never connect to while connecting to one we never checked is the
  // shape of an SSRF hole, not a defence against one.
  if (daemon.kind === "tcp") {
    const guard = await refusesPrivate(
      daemon.host,
      ctx.allowPrivateTargets,
      ctx.lookup,
    );
    if (guard) {
      return {
        facts: {},
        responseTimeMs: null,
        statusCode: null,
        error: guard,
      };
    }
  }

  const startedAt = performance.now();
  try {
    return await inspect(daemon, containerName, ctx.timeoutMs, startedAt);
  } catch (error) {
    // `http.request` validates its options synchronously and throws on a
    // malformed one. A throw here escapes `runMonitorCheck`, so no row is
    // written and `nextEvaluationAt` never advances — the monitor is then
    // re-enqueued every tick forever with nothing to show for it.
    return transportFailure(
      error instanceof Error ? error.message : "Docker inspect failed",
      elapsedSince(startedAt),
    );
  }
}

function inspect(
  daemon: Daemon,
  containerName: string,
  timeoutMs: number,
  startedAt: number,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const settle = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resolve(result);
    };

    const request = http.request(
      {
        method: "GET",
        // Encoded because the name reaches a request path. Docker names
        // cannot contain a slash, but this value is operator-supplied
        // and a path is not the place to find that out.
        path: `/containers/${encodeURIComponent(containerName)}/json`,
        headers: { accept: "application/json" },
        ...(daemon.kind === "socket"
          ? { socketPath: daemon.socketPath }
          : { host: daemon.host, port: daemon.port }),
      },
      (response) => {
        let body = "";
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_BODY_BYTES) {
            settle(
              transportFailure(
                "The Docker daemon returned an oversized response",
                elapsedSince(startedAt),
              ),
            );
            return;
          }
          body += chunk;
        });
        response.once("end", () =>
          settle(
            interpret(
              response.statusCode ?? 0,
              body,
              elapsedSince(startedAt),
              containerName,
            ),
          ),
        );
        response.once("error", (error: Error) =>
          settle(transportFailure(error.message, elapsedSince(startedAt))),
        );
      },
    );

    request.setTimeout(timeoutMs, () =>
      settle(
        transportFailure(
          `Timed out after ${timeoutMs}ms`,
          elapsedSince(startedAt),
        ),
      ),
    );
    request.once("error", (error: NodeJS.ErrnoException) =>
      settle(connectionFailure(error, elapsedSince(startedAt))),
    );
    request.end();
  });
}

/**
 * Turns one API response into facts. Pure, and exported, because every
 * decision this check makes lives here — the socket around it is
 * plumbing, and this is the part worth testing without a daemon.
 */
export function interpret(
  status: number,
  body: string,
  responseTimeMs: number,
  containerName: string,
): ProbeResult {
  // A 404 is an answer, not a failure: the daemon replied, and what it
  // said was "no such container". That is exactly what the `running`
  // assertion exists to judge — a container deleted rather than stopped
  // is still an outage — so it is recorded as a measurement. Calling it
  // a transport error would classify it as "could not reach the daemon"
  // and throw away the `state` fact that tells the two apart.
  if (status === 404) {
    return {
      facts: { running: false, state: "missing", responseTimeMs },
      responseTimeMs,
      statusCode: status,
      error: null,
    };
  }

  // Any other 4xx is Vigil asking wrongly, not the container failing: a
  // daemon behind mutual TLS answers 400 to a plaintext request, and so
  // does one that rejects the API version. Paging on-call about a
  // container that is fine is the one thing this must not do.
  if (status >= 400 && status < 500) {
    return unavailable(
      `The Docker daemon rejected the request with ${status}`,
      responseTimeMs,
      status,
    );
  }

  if (status !== 200) {
    return transportFailure(
      `The Docker daemon returned ${status}`,
      responseTimeMs,
      status,
    );
  }

  // Parsed defensively rather than cast: `JSON.parse` returns `any`, and
  // a daemon answering `null` — or `State` as a string — would throw out
  // of the probe on a shape check that optional chaining does not make.
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return transportFailure(
      "The Docker daemon returned malformed JSON",
      responseTimeMs,
      status,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    return transportFailure(
      `The Docker daemon returned an unexpected shape for ${containerName}`,
      responseTimeMs,
      status,
    );
  }

  const bodyObject = parsed as InspectResponse;
  const state = bodyObject.State;
  const restartCount = bodyObject.RestartCount;
  const containerId = bodyObject.Id;

  return {
    facts: {
      running: typeof state?.Running === "boolean" ? state.Running : null,
      state: typeof state?.Status === "string" ? state.Status : null,
      // Absent unless the image declares a HEALTHCHECK, which most do
      // not. Null, not "healthy". The assertion only fires on
      // `unhealthy`, so an image that never opted in stays silent.
      health:
        typeof state?.Health?.Status === "string" ? state.Health.Status : null,
      restartCount: typeof restartCount === "number" ? restartCount : null,
      containerId:
        typeof containerId === "string" && containerId.length > 0
          ? containerId
          : null,
      responseTimeMs,
    },
    responseTimeMs,
    statusCode: status,
    error: null,
  };
}

/**
 * A failure to open the connection, split by what it says about who is
 * at fault. A refused socket is the daemon being down, which is news
 * about the host and belongs in the outage. A socket that is not there,
 * or that this process may not open, is a worker that was never wired to
 * Docker — an operator error, and an operator error that reads as an
 * outage is the one failure a monitoring product may not have.
 */
function connectionFailure(
  error: NodeJS.ErrnoException,
  responseTimeMs: number,
): ProbeResult {
  if (error.code === "ENOENT") {
    return unavailable(
      "No Docker socket at this path. Bind-mount the daemon's socket into the worker, or point this monitor at a tcp:// engine.",
      responseTimeMs,
    );
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return unavailable(
      "The worker may not open the Docker socket. Add its user to the `docker` group, or grant the socket file read and write for that user.",
      responseTimeMs,
    );
  }
  return transportFailure(error.message, responseTimeMs);
}

function transportFailure(
  error: string,
  responseTimeMs: number,
  statusCode: number | null = null,
): ProbeResult {
  return { facts: { responseTimeMs }, responseTimeMs, statusCode, error };
}

/** Vigil could not find out — never `down`, always the operator's cue. */
function unavailable(
  reason: string,
  responseTimeMs: number | null,
  statusCode: number | null = null,
): ProbeResult {
  return {
    facts: responseTimeMs === null ? {} : { responseTimeMs },
    responseTimeMs,
    statusCode,
    error: null,
    unavailable: reason,
  };
}
