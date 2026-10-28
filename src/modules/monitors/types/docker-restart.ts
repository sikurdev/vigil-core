import type { FactBag } from "./contract";
import type { Verdict } from "./conditions";

/**
 * Restart-loop memory for the Docker check.
 *
 * The inspect is a point in time. `RestartCount` is a total since the
 * container was created, so the first sample this install has ever seen
 * is a baseline, not an alarm: a container that restarted four hundred
 * times before anyone watched it is not a loop we observed. Later
 * samples compare against that baseline, inside a window.
 *
 * A new container id, or a count that went backwards, is a different
 * container. Docker resets `RestartCount` when the container is
 * recreated. That sample is a new baseline.
 *
 * A gap longer than the window is the same idea. The restarts in the
 * gap cannot be placed inside it, and calling them a loop would page
 * for a history we do not have.
 */

export const DEFAULT_RESTART_LOOP_THRESHOLD = 3;
export const DEFAULT_RESTART_LOOP_WINDOW_MINUTES = 10;

/** Enough for the default window even at the shortest ordinary interval. */
const MAX_SAMPLES = 2_000;

export const UNHEALTHY_DOWN_REASON = "The container's healthcheck is failing";

export interface DockerRestartSample {
  at: string;
  count: number;
}

export interface DockerCheckState {
  containerId: string | null;
  samples: DockerRestartSample[];
  /**
   * An open incident was caused by a restart loop or by unhealthy
   * counted as down. A later degraded sample must not close it. Only
   * a clean up clears this.
   */
  holdResolve: boolean;
}

export function restartLoopReason(
  restarts: number,
  windowMinutes: number,
): string {
  return `restart loop: ${restarts} restarts in ${windowMinutes} min`;
}

export function readDockerCheckState(value: unknown): DockerCheckState | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as {
    containerId?: unknown;
    holdResolve?: unknown;
    samples?: unknown;
  };
  const samples = Array.isArray(row.samples)
    ? row.samples.flatMap((sample) => {
        if (sample === null || typeof sample !== "object") return [];
        const at = (sample as { at?: unknown }).at;
        const count = (sample as { count?: unknown }).count;
        if (typeof at !== "string" || typeof count !== "number") return [];
        if (!Number.isFinite(count) || Number.isNaN(Date.parse(at))) return [];
        return [{ at, count }];
      })
    : [];
  return {
    containerId: typeof row.containerId === "string" ? row.containerId : null,
    holdResolve: row.holdResolve === true,
    samples,
  };
}

export interface AssessDockerStateInput {
  now: Date;
  containerId: string | null;
  restartCount: number | null;
  enabled: boolean;
  threshold: number;
  windowMinutes: number;
  previous: DockerCheckState | null;
}

export interface DockerStateAssessment {
  state: DockerCheckState;
  reason: string | null;
}

export function assessDockerState(
  input: AssessDockerStateInput,
): DockerStateAssessment {
  const previous = input.previous;
  const holdResolve = previous?.holdResolve ?? false;
  if (
    input.containerId === null ||
    input.restartCount === null ||
    !Number.isFinite(input.restartCount)
  ) {
    return {
      reason: null,
      state: previous ?? {
        containerId: null,
        samples: [],
        holdResolve,
      },
    };
  }

  const nowIso = input.now.toISOString();
  const last = previous?.samples.at(-1) ?? null;
  const sameContainer =
    previous?.containerId === input.containerId &&
    last !== null &&
    input.restartCount >= last.count;

  if (!sameContainer) {
    return {
      reason: null,
      state: {
        containerId: input.containerId,
        samples: [{ at: nowIso, count: input.restartCount }],
        holdResolve,
      },
    };
  }

  const cutoff = input.now.getTime() - input.windowMinutes * 60_000;
  const lastAt = Date.parse(last.at);
  if (Number.isNaN(lastAt) || lastAt < cutoff) {
    return {
      reason: null,
      state: {
        containerId: input.containerId,
        samples: [{ at: nowIso, count: input.restartCount }],
        holdResolve,
      },
    };
  }

  const kept = previous.samples.filter((sample) => {
    const at = Date.parse(sample.at);
    return !Number.isNaN(at) && at >= cutoff;
  });
  const samples = [...kept, { at: nowIso, count: input.restartCount }].slice(
    -MAX_SAMPLES,
  );
  const oldest = samples[0];
  const increase = oldest ? input.restartCount - oldest.count : 0;
  const reason =
    input.enabled && increase >= input.threshold
      ? restartLoopReason(increase, input.windowMinutes)
      : null;

  return {
    reason,
    state: { containerId: input.containerId, samples, holdResolve },
  };
}

export function nextHoldResolve(input: {
  previous: boolean;
  verdict: Verdict;
  restartLoop: boolean;
  unhealthyDown: boolean;
}): boolean {
  if (input.verdict === "up") return false;
  if (input.verdict === "down" && (input.restartLoop || input.unhealthyDown)) {
    return true;
  }
  return input.previous;
}

/** Lines worth writing on the incident timeline, and nowhere public. */
export function dockerIncidentLines(result: {
  facts: FactBag;
  failedAssertions: readonly string[];
}): string[] {
  const lines: string[] = [];
  const loop = result.facts.restartLoop;
  if (typeof loop === "string" && loop.length > 0) lines.push(loop);
  if (result.failedAssertions.includes("health-down")) {
    lines.push(UNHEALTHY_DOWN_REASON);
  }
  return lines;
}
