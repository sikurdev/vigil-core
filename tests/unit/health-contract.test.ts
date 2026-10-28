import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { READINESS_TIMEOUT_MS } from "@/lib/readiness";

/**
 * Which probe each deployment surface asks, and in which order the
 * services come up.
 *
 * Both halves are unreachable from a unit test of the endpoint itself.
 * `/api/ready` can be perfectly strict while `docker-compose.yml` still
 * asks `/api/live`, and the container is then marked healthy — and
 * `depends_on: service_healthy` satisfied — by a process whose schema
 * does not exist. That is the whole failure this release is about, and
 * it lives in YAML.
 *
 * The ordering assertions are the other half of the same claim. The
 * endpoint refusing traffic before migrations finish is only useful
 * because nothing starts the app before the one-shot `migrate` job has
 * exited zero; if that edge were dropped, readiness would flap through
 * every deploy instead of gating one.
 *
 * Deliberately not a YAML parser, for the reason
 * `tests/unit/dockerfile-sources.test.ts` gives about Dockerfiles: the
 * strings being asserted on are short, exact and quoted in the failure.
 *
 * NOT marked `ee`, and for the same reason that file is not: it
 * discovers which surfaces are present rather than carrying an edition
 * marker. Core keeps both compose files, all three routes and the whole
 * of `vigilctl`, and it is the edition with the weaker CI — its workflow
 * runs lint, typecheck, test and build and nothing that speaks HTTP — so
 * a guard that deleted itself from Core would remove the only check Core
 * has on the question. What it must not do is assert on the release
 * harnesses and the edition gate, which exist only here.
 */

const ROOT = join(import.meta.dirname, "..", "..");

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const present = (p: string) => existsSync(join(ROOT, p));

/**
 * Compose files that stand up the web application, wherever this
 * edition keeps them. The Easypanel file is tooling input under
 * `scripts/core-overlay/` here and Core's own root-level compose file
 * there, and it is held to the same rule in both places.
 */
const COMPOSE = [
  "docker-compose.yml",
  "scripts/core-overlay/docker-compose.easypanel.yml",
  "docker-compose.easypanel.yml",
].filter(present);

describe("the endpoints exist and say what they are", () => {
  it("liveness imports nothing, so it cannot need a database", () => {
    const source = read("src/app/api/live/route.ts");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).toContain('{ status: "ok" }');
    expect(source).toContain("no-store");
  });

  it("readiness and the /api/health alias share one implementation", () => {
    for (const route of ["ready", "health"]) {
      const source = read(`src/app/api/${route}/route.ts`);
      expect(source).toContain('from "@/lib/readiness"');
      expect(source).toContain("readinessResponse()");
    }
  });

  it("readiness never migrates", () => {
    const source = read("src/lib/readiness.ts");
    // The one thing a readiness probe must not do. `migrate` is the
    // drizzle entry point; naming it here is a grep that fails loudly if
    // somebody ever wires the two together for convenience.
    expect(source).not.toContain("drizzle-orm/node-postgres/migrator");
    expect(source).not.toMatch(/\bmigrate\(/);
  });
});

describe("what the container healthchecks ask", () => {
  it("found the compose files this edition ships", () => {
    // A filter that silently matched nothing would make every assertion
    // below vacuous, which is the failure mode of a discovered list.
    expect(COMPOSE).toContain("docker-compose.yml");
    expect(COMPOSE.length).toBe(2);
  });

  for (const file of COMPOSE) {
    it(`${file} probes readiness, not liveness`, () => {
      // The path inside the healthcheck's own `fetch`, so a comment
      // explaining why liveness is the wrong choice here cannot satisfy
      // or break the assertion.
      const probed = read(file).match(
        /fetch\('http:\/\/localhost:3000(\/api\/[a-z]+)'\)/,
      );
      // A healthcheck answers `service_healthy` and colours `docker ps`,
      // and both of those questions mean "may this be used".
      expect(probed?.[1]).toBe("/api/ready");
    });
  }
});

describe("the probe answers inside the budget its caller allows", () => {
  for (const file of COMPOSE) {
    it(`${file} gives the healthcheck more time than the probe takes`, () => {
      // The two numbers are set in different files and neither mentions
      // the other. If the healthcheck's timeout were tightened below the
      // probe's own deadline, docker would kill the check rather than
      // read the 503 it was about to get, and the only symptom would be
      // an unhealthy container with nothing in the app log.
      // The healthcheck block that calls the probe, not the first one in
      // the file: `postgres` has one too, and it answers a different
      // question with a timeout of its own.
      const block = read(file)
        .split(/^\s*healthcheck:/m)
        .slice(1)
        .find((chunk) => chunk.includes("/api/ready"));
      const allowed = Number(block?.match(/timeout:\s*(\d+)s/)?.[1]) * 1_000;
      expect(allowed).toBeGreaterThan(0);
      expect(READINESS_TIMEOUT_MS).toBeLessThan(allowed);
    });
  }
});

describe("nothing serves before the migrations have finished", () => {
  for (const file of COMPOSE) {
    it(`${file} starts the app and the worker only after migrate exits 0`, () => {
      const source = read(file);
      // Two services in each file depend on the one-shot job, and the
      // condition has to be `completed_successfully` — `service_started`
      // would let both race the migration they are waiting for.
      const gates = source.match(
        /depends_on:\s*\n\s*migrate:\s*\n\s*condition: service_completed_successfully/g,
      );
      expect(gates?.length).toBe(2);
    });

    it(`${file} runs the migrate job against a database that is up`, () => {
      const source = read(file);
      expect(source).toMatch(
        /depends_on:\s*\n\s*postgres:\s*\n\s*condition: service_healthy/,
      );
    });
  }
});

describe("the release and lifecycle harnesses wait on readiness", () => {
  // `vigilctl` is in both editions; the demo script, the release
  // harnesses and the gate are commercial-only, so the list is filtered
  // by what this tree actually has.
  const waiters: [string, string][] = (
    [
      ["scripts/vigilctl/stack.sh", "app_ready"],
      ["scripts/probe-demo.sh", "app_ready"],
      ["scripts/release/compose-journey.sh", "/api/ready"],
      ["scripts/release/compose-upgrade.sh", "/api/ready"],
      ["scripts/edition-gate.sh", "/api/ready"],
    ] as [string, string][]
  ).filter(([file]) => present(file));

  it("found the lifecycle surfaces this edition ships", () => {
    expect(waiters.map(([file]) => file)).toContain(
      "scripts/vigilctl/stack.sh",
    );
  });

  for (const [file, needle] of waiters) {
    it(`${file} waits on ${needle}`, () => {
      expect(read(file)).toContain(needle);
    });
  }

  /**
   * A shell file with its whole-line comments removed, the idiom
   * `tests/unit/vigilctl.test.ts` uses for the same reason: explaining
   * why liveness is the wrong probe here requires naming it, and a
   * guard answered by deleting the explanation is the wrong guard.
   */
  const codeOf = (file: string) =>
    read(file)
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

  it("no start-up gate waits on liveness to decide the stack is usable", () => {
    // `/api/live` answers before the schema exists. A gate that read it
    // would hand the next step — a sign-up, a seed, a migration
    // assertion — a database it cannot write to. The edition gate is
    // exempt because it asserts on all three deliberately, below.
    for (const [file] of waiters) {
      if (file === "scripts/edition-gate.sh") continue;
      expect(
        `${file}: ${codeOf(file).includes("/api/live") ? "waits on liveness" : ""}`,
      ).toBe(`${file}: `);
    }
  });

  it.runIf(present("scripts/release/compose-upgrade.sh"))(
    "the upgrade harness asks each release for the probe that release has",
    () => {
      // `/api/ready` did not exist before this change, so the phase that
      // installs the PREVIOUS tagged release has to wait on the alias.
      // Asking it for `/api/ready` gets a 404 until the 300-second
      // deadline, and the harness then reports the upgrade as broken
      // when what is broken is the harness. Found by running it.
      const upgrade = read("scripts/release/compose-upgrade.sh");
      expect(upgrade).toContain("wait_app /api/health");
      expect(upgrade).toContain("wait_app /api/ready");
      // In that order: the old release first, then the current tree.
      expect(upgrade.indexOf("wait_app /api/health")).toBeLessThan(
        upgrade.indexOf("wait_app /api/ready"),
      );
    },
  );

  it.runIf(present("scripts/edition-gate.sh"))(
    "the edition gate proves all three endpoints against Core",
    () => {
      // Core's own CI (scripts/core-overlay/ci.yml) runs lint, typecheck,
      // test and build and nothing that speaks HTTP, so the gate's smoke
      // step is the only place these are exercised over HTTP against a
      // database Core itself migrated. The gate is commercial-only, so
      // this assertion runs only in the tree that has it.
      const gate = read("scripts/edition-gate.sh");
      for (const path of ["/api/ready", "/api/live", "/api/health"]) {
        expect(gate).toContain(`localhost:$PORT${path}`);
      }
    },
  );
});

/**
 * The probe `vigilctl` runs inside the container, driven for real.
 *
 * It matters most in the one place it is hardest to reach: `rollback`
 * checks out a PREVIOUS release and rebuilds from it, while the shell
 * functions loaded in the running process are still the new ones. A
 * release from before `/api/ready` existed answers 404 to it forever, so
 * a probe that knew only the new path would call every rollback across
 * this boundary a failure — and `rollback_failed` does not warn, it
 * tells the operator the rollback did not happen.
 *
 * The JavaScript is lifted out of `stack.sh` rather than restated here.
 * A copy would keep passing after somebody simplified the original.
 */
describe("the probe vigilctl runs inside the container", () => {
  /** The `node -e` body of `app_ready`, as the shell passes it. */
  function probeSource(port: number): string {
    const stack = read("scripts/vigilctl/stack.sh");
    const body = stack.match(/node -e "\n([\s\S]*?)\n\s*" >\/dev\/null/);
    expect(
      body,
      "app_ready no longer has an extractable node -e body",
    ).toBeTruthy();
    return body![1]!.replaceAll(
      "http://127.0.0.1:3000",
      `http://127.0.0.1:${port}`,
    );
  }

  const servers: Server[] = [];

  /** Serves `routes`; anything else 404s with an HTML body, the way Next
   * answers a path that does not exist in that build. */
  async function listen(
    routes: Record<string, { status: number; body: unknown }>,
  ): Promise<number> {
    const server = createServer((req, res) => {
      const route = routes[req.url ?? ""];
      if (!route) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html>404</html>");
        return;
      }
      res.writeHead(route.status, { "content-type": "application/json" });
      res.end(JSON.stringify(route.body));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("no port");
    }
    return address.port;
  }

  afterAll(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  const OK = { status: 200, body: { status: "ok" } };
  const DOWN = { status: 503, body: { status: "unavailable" } };

  /**
   * Async on purpose. `spawnSync` blocks this process's event loop, and
   * the servers above live in it — the child's connection is never
   * accepted and the suite deadlocks with no output at all.
   */
  const run = (port: number) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["-e", probeSource(port)], {
        stdio: "ignore",
      });
      child.on("close", (code) => resolve(code));
    });

  it("accepts a release that only has /api/health", async () => {
    // Every release before this one. The alias is what it serves, and
    // what it means by it is the strictest answer that build can give.
    expect(await run(await listen({ "/api/health": OK }))).toBe(0);
  });

  it("accepts a release that has both and is ready", async () => {
    expect(
      await run(await listen({ "/api/ready": OK, "/api/health": OK })),
    ).toBe(0);
  });

  it("refuses a release that has both and is not ready", async () => {
    // The fallback must not rescue a real 503: `/api/ready` answered, so
    // there is nothing to fall back to.
    expect(
      await run(await listen({ "/api/ready": DOWN, "/api/health": DOWN })),
    ).toBe(1);
  });

  it("refuses a process that answers nothing at all", async () => {
    expect(await run(await listen({}))).toBe(1);
  });
});
