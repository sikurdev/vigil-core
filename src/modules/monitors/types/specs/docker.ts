import { z } from "zod";

import { DEFAULT_DOCKER_SOCKET, dockerDescriptor } from "../catalog";
import type { Assertion, CheckTypeSpec, MonitorRowView } from "../contract";
import {
  DEFAULT_RESTART_LOOP_THRESHOLD,
  DEFAULT_RESTART_LOOP_WINDOW_MINUTES,
  UNHEALTHY_DOWN_REASON,
} from "../docker-restart";
import { monitorHostnameSchema } from "../targets";
import { latencyAssertion } from "./shared";

/**
 * Is a named container running, asked of the Docker Engine API.
 *
 * The target is the Docker *host*, not the container. One daemon holds
 * many containers, and the host is the thing an operator already has a
 * name for — the name that means something in an incident email, and the
 * name they would type for every other check type. The container is a
 * config setting, and `describeTarget` prints both so a notification
 * still says which container on which box.
 *
 * That leaves the common case — a daemon on the worker's own machine,
 * reached over `/var/run/docker.sock` — with a target that is never
 * dialled. Every alternative was worse. Making the target the socket
 * path fails `monitorHostnameSchema` and would make this the one type
 * whose target field is not a host. Making it the container name
 * contradicts the assignment of every other type's target field and
 * leaves the daemon address with nowhere honest to live once a second
 * host appears. So: the target names the machine whose daemon is being
 * asked, and is the monitor's identity; `socketPath` says how to reach
 * that daemon. Over a unix socket the target is a label, and the help
 * text says as much rather than pretending otherwise.
 *
 * `socketPath` is named for what it holds nine times in ten. A
 * `tcp://host:2375` value switches the transport to a remote engine —
 * see the probe, which is also where the private-address guard becomes
 * conditional.
 */

export interface DockerConfig {
  /**
   * Container name or id. Null when the monitor has none — the form has
   * no section for it yet, and `storedSchema` must accept an empty
   * submission, so an unconfigured monitor is representable. The probe
   * reports that as `misconfigured` rather than probing nothing.
   */
  containerName: string | null;
  /** Unix socket path, or a `tcp://host:port` daemon address. */
  socketPath: string;
  degradedThresholdMs: number;
  /** Compare `RestartCount` across samples. Off still records them. */
  restartLoopEnabled: boolean;
  /** Rise inside the window that marks the monitor down. */
  restartLoopThreshold: number;
  restartLoopWindowMinutes: number;
  /**
   * `unhealthy` is down, and the failure window still has to elapse
   * before an incident opens. Off keeps the old degraded verdict.
   */
  unhealthyIsDown: boolean;
}

export const dockerStoredSchema = z.object({
  containerName: z
    .string()
    .trim()
    .min(1, "Enter the container's name or id.")
    .max(255)
    .nullish()
    .transform((value) => value ?? null),
  socketPath: z.string().trim().min(1).max(255).default(DEFAULT_DOCKER_SOCKET),
  restartLoopEnabled: z.boolean().default(true),
  restartLoopThreshold: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_RESTART_LOOP_THRESHOLD),
  restartLoopWindowMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(DEFAULT_RESTART_LOOP_WINDOW_MINUTES),
  unhealthyIsDown: z.boolean().default(true),
});

export const dockerConfigSchema: z.ZodType<DockerConfig> = z.object({
  containerName: z.string().max(255).nullable(),
  socketPath: z.string().min(1).max(255),
  degradedThresholdMs: z.number().int().min(100).max(30_000),
  restartLoopEnabled: z.boolean(),
  restartLoopThreshold: z.number().int().min(1).max(100),
  restartLoopWindowMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  unhealthyIsDown: z.boolean(),
});

const isRunning: Assertion<DockerConfig> = {
  id: "running",
  fact: "running",
  severity: "down",
  evaluate(value, config) {
    if (value === true) return null;
    const name = config.containerName ?? "The container";
    // A container that no longer exists lands here too — the probe
    // records that as `running: false` with `state: "missing"`, because
    // a deleted container is an outage and not an unreachable daemon.
    // The assertion cannot read `state`, so the wording covers both and
    // the fact on the timeline tells them apart.
    if (value === false) return `${name} is not running`;
    return "The daemon reported no state for this container";
  },
};

function unhealthy(value: unknown): string | null {
  // Only `unhealthy` is a verdict. Most images declare no HEALTHCHECK
  // at all and report nothing, and `starting` is a container inside
  // its grace period. Treating either as a failure would make the
  // check amber for every image that never opted in.
  return value === "unhealthy" ? UNHEALTHY_DOWN_REASON : null;
}

const unhealthyDown: Assertion<DockerConfig> = {
  id: "health-down",
  fact: "health",
  severity: "down",
  applies: (config) => config.unhealthyIsDown,
  evaluate: unhealthy,
};

const unhealthyDegraded: Assertion<DockerConfig> = {
  id: "health",
  fact: "health",
  severity: "degraded",
  applies: (config) => !config.unhealthyIsDown,
  evaluate: unhealthy,
};

const restartLoop: Assertion<DockerConfig> = {
  id: "restart-loop",
  fact: "restartLoop",
  severity: "down",
  evaluate(value) {
    // The comparison lives in `docker-restart.ts`, which needs the
    // previous sample. This assertion only repeats the sentence it
    // wrote, so a stored observation can be re-judged without the
    // memory that produced it.
    return typeof value === "string" && value.length > 0 ? value : null;
  },
};

export const dockerSpec: CheckTypeSpec<DockerConfig> = {
  descriptor: dockerDescriptor,
  configSchema: dockerConfigSchema,
  storedSchema: dockerStoredSchema,
  targetSchema: monitorHostnameSchema,
  assertions: [
    isRunning,
    restartLoop,
    unhealthyDown,
    unhealthyDegraded,
    latencyAssertion<DockerConfig>("Answered"),
  ],
  fromRow(row: MonitorRowView): DockerConfig {
    const stored = dockerStoredSchema.safeParse(row.config ?? {});
    const data = stored.success ? stored.data : dockerStoredSchema.parse({});
    return {
      containerName: data.containerName,
      socketPath: data.socketPath,
      degradedThresholdMs: row.degradedThresholdMs,
      restartLoopEnabled: data.restartLoopEnabled,
      restartLoopThreshold: data.restartLoopThreshold,
      restartLoopWindowMinutes: data.restartLoopWindowMinutes,
      unhealthyIsDown: data.unhealthyIsDown,
    };
  },
  describeTarget(target, _port, config) {
    return config.containerName === null
      ? target
      : `${config.containerName} on ${target}`;
  },
};
