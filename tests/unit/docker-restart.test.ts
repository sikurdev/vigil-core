import { describe, expect, it } from "vitest";

import { judge } from "@/modules/monitors/types/conditions";
import {
  assessDockerState,
  dockerIncidentLines,
  nextHoldResolve,
  readDockerCheckState,
  restartLoopReason,
  type DockerCheckState,
} from "@/modules/monitors/types/docker-restart";
import { interpret } from "@/modules/monitors/types/probes/docker";
import {
  dockerSpec,
  type DockerConfig,
} from "@/modules/monitors/types/specs/docker";

const T0 = new Date("2026-10-28T12:00:00.000Z");
const plus = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function memory(
  samples: { minutes: number; count: number }[],
  extras: Partial<DockerCheckState> = {},
): DockerCheckState {
  return {
    containerId: "abc",
    samples: samples.map((sample) => ({
      at: plus(sample.minutes).toISOString(),
      count: sample.count,
    })),
    holdResolve: false,
    ...extras,
  };
}

function assess(
  overrides: Partial<Parameters<typeof assessDockerState>[0]> = {},
) {
  return assessDockerState({
    now: plus(10),
    containerId: "abc",
    restartCount: 3,
    enabled: true,
    threshold: 3,
    windowMinutes: 10,
    previous: memory([{ minutes: 0, count: 0 }]),
    ...overrides,
  });
}

const baseConfig: DockerConfig = {
  containerName: "web",
  socketPath: "/var/run/docker.sock",
  degradedThresholdMs: 3_000,
  restartLoopEnabled: true,
  restartLoopThreshold: 3,
  restartLoopWindowMinutes: 10,
  unhealthyIsDown: true,
};

function judgeDocker(
  facts: Record<string, string | number | boolean | null>,
  config: Partial<DockerConfig> = {},
) {
  return judge(
    dockerSpec.assertions,
    { ...baseConfig, ...config },
    {
      facts,
      responseTimeMs: 12,
      statusCode: 200,
      error: null,
    },
  );
}

describe("restart loop memory", () => {
  it("does not alarm on the first sample, whatever the absolute count is", () => {
    const result = assess({
      previous: null,
      restartCount: 400,
      now: T0,
    });

    expect(result.reason).toBeNull();
    expect(result.state.samples).toEqual([
      { at: T0.toISOString(), count: 400 },
    ]);
    expect(result.state.containerId).toBe("abc");
  });

  it("marks down once the count rises by the threshold inside the window", () => {
    const result = assess();

    expect(result.reason).toBe(restartLoopReason(3, 10));
    expect(result.reason).toBe("restart loop: 3 restarts in 10 min");
    expect(result.state.samples).toHaveLength(2);
  });

  it("stays quiet when the rise is below the threshold", () => {
    expect(assess({ restartCount: 2 }).reason).toBeNull();
  });

  it("does not alarm when the check is switched off, and still records the sample", () => {
    const result = assess({ enabled: false });

    expect(result.reason).toBeNull();
    expect(result.state.samples).toHaveLength(2);
  });

  it("treats a new container id as a first sample", () => {
    const result = assess({
      containerId: "def",
      restartCount: 8,
    });

    expect(result.reason).toBeNull();
    expect(result.state.containerId).toBe("def");
    expect(result.state.samples).toEqual([
      { at: plus(10).toISOString(), count: 8 },
    ]);
  });

  it("treats a falling restart count as a recreated container", () => {
    const result = assess({
      previous: memory([{ minutes: 9, count: 20 }]),
      restartCount: 1,
    });

    expect(result.reason).toBeNull();
    expect(result.state.samples).toEqual([
      { at: plus(10).toISOString(), count: 1 },
    ]);
  });

  it("does not attribute restarts across a gap longer than the window", () => {
    const result = assess({
      previous: memory([{ minutes: -1, count: 0 }]),
      restartCount: 9,
      now: plus(10),
    });

    expect(result.reason).toBeNull();
    expect(result.state.samples).toEqual([
      { at: plus(10).toISOString(), count: 9 },
    ]);
  });

  it("counts only samples still inside the window", () => {
    const result = assess({
      now: plus(12),
      previous: memory([
        { minutes: 0, count: 0 },
        { minutes: 3, count: 1 },
      ]),
      restartCount: 3,
    });

    // The sample at minute 0 is outside a 10 minute window ending at
    // minute 12. The rise from the sample that remains is 2.
    expect(result.reason).toBeNull();
    expect(result.state.samples.map((sample) => sample.count)).toEqual([1, 3]);
  });

  it("leaves the remembered samples alone when this inspect had no count", () => {
    const previous = memory([{ minutes: 9, count: 4 }]);
    const result = assess({ previous, restartCount: null });

    expect(result.reason).toBeNull();
    expect(result.state.samples).toEqual(previous.samples);
  });

  it("reads a stored blob defensively", () => {
    expect(readDockerCheckState(null)).toBeNull();
    expect(
      readDockerCheckState({
        containerId: "abc",
        holdResolve: true,
        samples: [
          { at: T0.toISOString(), count: 2 },
          { at: "nope", count: 1 },
          { count: 3 },
        ],
      }),
    ).toEqual({
      containerId: "abc",
      holdResolve: true,
      samples: [{ at: T0.toISOString(), count: 2 }],
    });
  });
});

describe("hold until a clean up", () => {
  it("holds after a restart loop or an unhealthy-as-down sample", () => {
    expect(
      nextHoldResolve({
        previous: false,
        verdict: "down",
        restartLoop: true,
        unhealthyDown: false,
      }),
    ).toBe(true);
    expect(
      nextHoldResolve({
        previous: false,
        verdict: "down",
        restartLoop: false,
        unhealthyDown: true,
      }),
    ).toBe(true);
  });

  it("keeps the hold through a later degraded sample and clears it on up", () => {
    expect(
      nextHoldResolve({
        previous: true,
        verdict: "degraded",
        restartLoop: false,
        unhealthyDown: false,
      }),
    ).toBe(true);
    expect(
      nextHoldResolve({
        previous: true,
        verdict: "up",
        restartLoop: false,
        unhealthyDown: false,
      }),
    ).toBe(false);
  });

  it("does not hold a plain not-running failure", () => {
    expect(
      nextHoldResolve({
        previous: false,
        verdict: "down",
        restartLoop: false,
        unhealthyDown: false,
      }),
    ).toBe(false);
  });
});

describe("docker verdicts", () => {
  it("reads the container id off the inspect", () => {
    const result = interpret(
      200,
      JSON.stringify({
        Id: "abc123",
        RestartCount: 4,
        State: {
          Status: "running",
          Running: true,
          Health: { Status: "healthy" },
        },
      }),
      12,
      "web",
    );

    expect(result.facts.containerId).toBe("abc123");
    expect(result.facts.restartCount).toBe(4);
  });

  it("treats a sustained unhealthy healthcheck as down by default", () => {
    const judged = judgeDocker({
      running: true,
      health: "unhealthy",
      restartLoop: null,
      responseTimeMs: 12,
    });

    expect(judged.verdict).toBe("down");
    expect(judged.error).toBe("The container's healthcheck is failing");
    expect(judged.failedAssertions).toContain("health-down");
  });

  it("keeps unhealthy as degraded when the operator says so", () => {
    const judged = judgeDocker(
      {
        running: true,
        health: "unhealthy",
        restartLoop: null,
        responseTimeMs: 12,
      },
      { unhealthyIsDown: false },
    );

    expect(judged.verdict).toBe("degraded");
    expect(judged.ok).toBe(true);
    expect(judged.failedAssertions).toContain("health");
    expect(judged.failedAssertions).not.toContain("health-down");
  });

  it("does not fail a container with no healthcheck", () => {
    const judged = judgeDocker({
      running: true,
      health: null,
      restartLoop: null,
      responseTimeMs: 12,
    });

    expect(judged.verdict).toBe("up");
  });

  it("uses the restart-loop reason as the down error", () => {
    const reason = "restart loop: 4 restarts in 10 min";
    const judged = judgeDocker({
      running: true,
      health: "healthy",
      restartLoop: reason,
      responseTimeMs: 12,
    });

    expect(judged.verdict).toBe("down");
    expect(judged.error).toBe(reason);
  });

  it("names both causes for the incident timeline", () => {
    expect(
      dockerIncidentLines({
        facts: { restartLoop: "restart loop: 3 restarts in 10 min" },
        failedAssertions: ["restart-loop", "health-down"],
      }),
    ).toEqual([
      "restart loop: 3 restarts in 10 min",
      "The container's healthcheck is failing",
    ]);
  });

  it("fills the defaults when a stored config predates the settings", () => {
    const config = dockerSpec.fromRow({
      checkType: "docker",
      url: "docker-1",
      port: null,
      method: "GET",
      intervalSeconds: 60,
      timeoutMs: 10_000,
      degradedThresholdMs: 3_000,
      expectedStatusCode: null,
      bodyKeyword: null,
      keywordAbsent: false,
      tlsCheck: false,
      tlsWarnDays: 14,
      config: { containerName: "web" },
    });

    expect(config.restartLoopEnabled).toBe(true);
    expect(config.restartLoopThreshold).toBe(3);
    expect(config.restartLoopWindowMinutes).toBe(10);
    expect(config.unhealthyIsDown).toBe(true);
  });
});
