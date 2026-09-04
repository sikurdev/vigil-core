import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every case in this file spawns bash, which spawns the CLI, which
// spawns the stub several times. That is milliseconds per process on
// Linux and closer to a second on Windows, and the health waits sleep
// between polls on purpose. The default five seconds fails the slow
// machine rather than the wrong behavior.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

/**
 * vigilctl, driven for real, against a Docker that is not there.
 *
 * The CLI is bash and its only dependency is a container runtime, which
 * makes it the kind of code that normally gets tested by running it once
 * by hand on a laptop and shipping. What it does, though, is stop the
 * app, drop tables and check out other commits, so the properties that
 * matter are the ones nobody wants to discover in production: that a
 * refusal fires BEFORE the destructive step and not after, that an
 * interrupted install can simply be run again, that no secret ever
 * reaches stdout, and that the exit code says which of those happened.
 *
 * Every one of those is decidable without Docker. `tests/fixtures/
 * vigilctl-docker.sh` answers as a daemon would and records every
 * invocation, so a test can assert on the ORDER of operations, which is
 * the actual safety property and the one an end-to-end run against real
 * containers is worst at proving.
 *
 * What this file does not cover, and does not pretend to: whether the
 * images build, whether the migrations apply, whether the app comes up.
 * That is `scripts/release/vigilctl-lifecycle.sh` in CI, on real
 * containers, once.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const STUB = join(ROOT, "tests", "fixtures", "vigilctl-docker.sh");

/** bash wants forward slashes even when node hands it backslashes. */
const posix = (p: string) => p.split("\\").join("/");

const workspaces: string[] = [];

/**
 * Whether this filesystem keeps a `chmod 600`.
 *
 * doctor warns about a `.env` that is readable beyond its owner, which
 * is a real finding on the Linux host the supported install runs on and
 * an unsatisfiable one under MSYS, where the mode comes back 644
 * whatever was asked for. Measured rather than guessed at from
 * `process.platform`, because the thing that matters is the filesystem
 * and not the operating system: the same check fails on a CIFS mount.
 */
function posixModesAreKept(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "vigilctl-mode-"));
  workspaces.push(dir);
  const probe = posix(join(dir, "probe"));
  writeFileSync(probe, "x");
  spawnSync("bash", ["-c", `chmod 600 '${probe}'`]);
  const mode = spawnSync("bash", ["-c", `stat -c '%a' '${probe}'`], {
    encoding: "utf8",
  });
  return (mode.stdout ?? "").trim() === "600";
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  output: string;
}

class Install {
  readonly dir: string;
  readonly state: string;
  readonly bin: string;

  constructor(dir: string) {
    this.dir = dir;
    this.state = join(dir, ".stub-state");
    this.bin = join(dir, ".stub-bin");
  }

  run(args: string[]): RunResult {
    const result = spawnSync(
      "bash",
      [posix(join(this.dir, "vigilctl")), ...args],
      {
        // Deliberately not the install directory: vigilctl resolves its
        // own repository from where the script lives, and an operator
        // running it from /root must get the same answer.
        cwd: tmpdir(),
        encoding: "utf8",
        env: {
          ...process.env,
          // The stub directory first, and everything else untouched.
          // Filtering PATH to hide a real pg_restore removed /usr/bin,
          // which on Linux is where bash lives too, and every spawn
          // failed to start at all.
          PATH: `${posix(this.bin)}${delimiter}${process.env.PATH ?? ""}`,
          STUB_STATE: posix(this.state),
          COMPOSE_PROJECT_NAME: "",
        },
      },
    );
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return {
      status: result.status ?? -1,
      stdout,
      stderr,
      output: `${stdout}${stderr}`,
    };
  }

  flag(name: string, value: string): void {
    writeFileSync(join(this.state, name), value);
  }

  clearFlag(name: string): void {
    rmSync(join(this.state, name), { force: true });
  }

  /** Every docker invocation so far, in order, one per line. */
  calls(): string[] {
    const file = join(this.state, "calls");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  }

  /** Index of the first call containing `needle`, or -1. */
  firstCall(needle: string): number {
    return this.calls().findIndex((line) => line.includes(needle));
  }

  env(): string {
    const file = join(this.dir, ".env");
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  envValue(key: string): string {
    const match = new RegExp(`^${key}=(.*)$`, "m").exec(this.env());
    return match?.[1] ?? "";
  }

  /** Put the stub in the state a healthy, installed stack would leave. */
  markInstalled(): void {
    for (const service of ["postgres", "app", "worker"]) {
      this.flag(`service-${service}`, "running");
    }
    this.flag("service-migrate", "exited");
    this.flag("exit-migrate", "0");
    this.flag("generation", "1");
    this.flag("cron", "5");
    this.flag("migrations_applied", String(migrationCount));
  }

  git(...args: string[]): string {
    const result = spawnSync("git", ["-C", this.dir, ...args], {
      encoding: "utf8",
    });
    return (result.stdout ?? "").trim();
  }
}

/**
 * Run a fragment of shell inside a throwaway install.
 *
 * The CLI's own libraries can be sourced into it, so a single function
 * that is not worth driving the whole command line for can be exercised
 * on its own, with the docker stub answering as usual.
 */
function runShell(cli: Install, script: string) {
  return shellWithout(cli, "", script);
}

/**
 * The same, with one program hidden from `command -v`.
 *
 * Every state-changing command stops with a sentence of its own when
 * there is no `docker`, and that branch cannot be forced with PATH: on
 * Linux `docker`, `bash` and `dirname` are all in the same directory, so
 * removing it to hide one removes the interpreter the CLI is written in.
 * That is not hypothetical. It is what the first version of this file
 * did, and every case failed to spawn on Linux while passing here.
 *
 * So the lookup is hidden instead. `command` is a regular builtin and a
 * shell function of the same name takes precedence over it, which says
 * "this host does not have that program" in one line and leaves the
 * environment everything else depends on exactly as it was. An empty
 * name hides nothing, which is what `runShell` above is.
 */
function shellWithout(cli: Install, hidden: string, script: string) {
  const hide =
    'command() { if [ "${2:-}" = "' +
    hidden +
    '" ]; then return 1; fi; builtin command "$@"; }';
  // Exported, so a script this fragment RUNS sees it too: bash imports
  // an exported function at startup and it takes precedence over the
  // builtin there as well. That is what lets scripts/backup.sh be
  // exercised as a real subprocess rather than sourced into the harness.
  const harness = [
    hide,
    "export -f command",
    `REPO='${posix(cli.dir)}'`,
    'cd "$REPO"',
    script,
  ].join("\n");
  return spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${posix(cli.bin)}${delimiter}${process.env.PATH ?? ""}`,
      STUB_STATE: posix(cli.state),
    },
  });
}

/** The two lines that put the CLI's own libraries in scope. */
const SOURCE_LIBS = [
  ". scripts/vigilctl/common.sh",
  ". scripts/vigilctl/stack.sh",
].join("\n");

/** How many migration files the fake checkout carries. */
const migrationCount = 3;

/**
 * A throwaway copy of everything vigilctl reads: itself, its libraries,
 * the two scripts it delegates to, the compose file it drives and a
 * migrations directory to count. Not the real repository, because
 * `install` writes a .env and `update` moves HEAD.
 */
function makeInstall(
  options: { git?: boolean; override?: boolean } = {},
): Install {
  const dir = mkdtempSync(join(tmpdir(), "vigilctl-"));
  workspaces.push(dir);
  const install = new Install(dir);

  cpSync(join(ROOT, "vigilctl"), join(dir, "vigilctl"));
  mkdirSync(join(dir, "scripts", "vigilctl"), { recursive: true });
  cpSync(join(ROOT, "scripts", "vigilctl"), join(dir, "scripts", "vigilctl"), {
    recursive: true,
  });
  for (const script of ["backup.sh", "restore.sh"]) {
    cpSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
  }
  cpSync(join(ROOT, "docker-compose.yml"), join(dir, "docker-compose.yml"));

  mkdirSync(join(dir, "drizzle"), { recursive: true });
  for (let i = 0; i < migrationCount; i += 1) {
    writeFileSync(join(dir, "drizzle", `000${i}_fixture.sql`), "select 1;\n");
  }
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "vigil", version: "0.0.0-test" }, null, 2)}\n`,
  );

  if (options.override) {
    writeFileSync(
      join(dir, "docker-compose.override.yml"),
      'services:\n  app:\n    environment:\n      DEMO_MODE: "true"\n',
    );
  }

  mkdirSync(install.bin, { recursive: true });
  mkdirSync(install.state, { recursive: true });
  cpSync(STUB, join(install.bin, "docker"));
  chmodSync(join(install.bin, "docker"), 0o755);
  // Node's chmod cannot set an executable bit on Windows; the shell
  // this all runs in can, and PATH lookup needs it on Linux.
  spawnSync("bash", [
    "-c",
    `chmod 755 '${posix(join(install.bin, "docker"))}'`,
  ]);

  if (options.git) {
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "--quiet", "--initial-branch=main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "vigilctl test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(
      join(dir, ".gitignore"),
      ".stub-state/\n.stub-bin/\nbackups/\n.env\n",
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    git("checkout", "--quiet", "-b", "next");
    writeFileSync(join(dir, "RELEASE-NOTE.md"), "the next version\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "next");
    git("checkout", "--quiet", "main");
  }

  return install;
}

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe("the command surface", () => {
  it("names every command in its help, and exits 0", () => {
    const cli = makeInstall();
    const help = cli.run(["help"]);
    expect(help.status).toBe(0);
    for (const command of [
      "install",
      "doctor",
      "backup",
      "restore",
      "update",
      "rollback",
    ]) {
      expect(help.stdout).toContain(command);
    }
  });

  it("exits 2 on a command that does not exist", () => {
    const cli = makeInstall();
    const result = cli.run(["reinstall"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no command called reinstall");
  });

  it("exits 2 when restore is given no archive", () => {
    const cli = makeInstall();
    expect(cli.run(["restore"]).status).toBe(2);
  });

  it("exits 2 on an option a command does not have", () => {
    const cli = makeInstall();
    expect(cli.run(["install", "--force"]).status).toBe(2);
  });

  it("reports the version without touching Docker", () => {
    const cli = makeInstall();
    const result = cli.run(["version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0.0.0-test");
    expect(cli.calls()).toHaveLength(0);
  });
});

describe("prerequisites", () => {
  it("says Docker is not installed, rather than that a daemon is unreachable", () => {
    // Hidden from `command -v` rather than removed from PATH. Deleting
    // the stub and leaving PATH alone means a machine that HAS Docker
    // (every CI runner does) answers with its real daemon, and the
    // suite goes off and builds images on it.
    const cli = makeInstall();
    const result = shellWithout(
      cli,
      "docker",
      `${SOURCE_LIBS}\nrequire_docker`,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker is not installed");
    expect(result.stderr).toContain("docs.docker.com");
    // Nothing reached a daemon, real or stubbed.
    expect(cli.calls()).toHaveLength(0);
  });

  it("names the missing Compose v2 plugin", () => {
    const cli = makeInstall();
    cli.flag("compose_v2", "0");
    const result = cli.run(["install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Compose v2");
  });

  it("names an unreachable daemon", () => {
    const cli = makeInstall();
    cli.flag("daemon", "0");
    const result = cli.run(["install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("daemon is not reachable");
  });

  it("stops the doctor report at Docker rather than blaming everything downstream", () => {
    const cli = makeInstall();
    cli.flag("daemon", "0");
    const result = cli.run(["doctor"]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("daemon is not reachable");
    // A wall of failures that all mean "no Docker" buries the one fact
    // the operator needs.
    expect(result.output).not.toContain("app health");
    expect(result.output).not.toContain("migrations");
  });
});

describe("secrets", () => {
  it("generates what is missing on a fresh install, and prints none of it", () => {
    const cli = makeInstall();
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(0);

    const secret = cli.envValue("BETTER_AUTH_SECRET");
    const password = cli.envValue("POSTGRES_PASSWORD");
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(password.length).toBeGreaterThanOrEqual(16);
    expect(result.output).toContain("generated");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain(password);
    expect(result.output).toContain("characters");
  });

  it("preserves an existing secret on every later install", () => {
    const cli = makeInstall();
    expect(cli.run(["install", "--yes"]).status).toBe(0);
    const secret = cli.envValue("BETTER_AUTH_SECRET");
    const password = cli.envValue("POSTGRES_PASSWORD");

    const again = cli.run(["install", "--yes"]);
    expect(again.output).toContain("preserved");
    expect(cli.envValue("BETTER_AUTH_SECRET")).toBe(secret);
    expect(cli.envValue("POSTGRES_PASSWORD")).toBe(password);
    expect(again.output).not.toContain(secret);
  });

  it("keeps every other line of an operator .env exactly as it was", () => {
    const cli = makeInstall();
    writeFileSync(
      join(cli.dir, ".env"),
      [
        "# my own notes",
        "RESEND_API_KEY=re_something",
        "APP_URL=https://vigil.example.com",
        "",
      ].join("\n"),
    );
    expect(cli.run(["install", "--yes"]).status).toBe(0);
    const env = cli.env();
    expect(env).toContain("# my own notes");
    expect(env).toContain("RESEND_API_KEY=re_something");
    expect(cli.envValue("APP_URL")).toBe("https://vigil.example.com");
  });

  it("refuses a secret the app would reject, rather than rotating it", () => {
    const cli = makeInstall();
    writeFileSync(join(cli.dir, ".env"), "BETTER_AUTH_SECRET=tooshort\n");
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("32");
    // Rotating it would sign every user out. It is still there.
    expect(cli.envValue("BETTER_AUTH_SECRET")).toBe("tooshort");
    expect(cli.firstCall("up")).toBe(-1);
  });

  it("does not invent a Postgres password for a volume that already exists", () => {
    // POSTGRES_PASSWORD initializes the role when the volume is first
    // created and is ignored forever after, so writing one here would
    // put a password in .env that the database has never heard of.
    const cli = makeInstall();
    cli.flag("volume", "1");
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(0);
    expect(cli.envValue("POSTGRES_PASSWORD")).toBe("");
    expect(result.output).toContain("volume already exists");
  });
});

describe("install", () => {
  it("installs, reports the endpoint, and exits 0", () => {
    const cli = makeInstall();
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("installed");
    expect(result.stdout).toContain("http://localhost:3000");
  });

  it("is a no-op the second time, and does not restart the stack to prove it", () => {
    // `docker compose up -d --build` is never a no-op here: the app and
    // the worker depend on the one-shot migrate job, which is recreated
    // on every up, so its dependents are recreated with it. A repeat
    // install that ran up anyway would bounce a healthy installation.
    const cli = makeInstall();
    expect(cli.run(["install", "--yes"]).status).toBe(0);

    rmSync(join(cli.state, "calls"), { force: true });
    const again = cli.run(["install", "--yes"]);
    expect(again.status).toBe(10);
    expect(again.stdout).toContain("nothing changed");
    expect(again.stdout).toContain("Nothing was restarted");
    expect(cli.calls().some((c) => c.includes(" up -d"))).toBe(false);
  });

  it("does start the stack again when .env changed under it", () => {
    // The other half of the same rule: skipping `up` is only safe while
    // nothing the containers read has changed since they started.
    const cli = makeInstall();
    expect(cli.run(["install", "--yes"]).status).toBe(0);
    writeFileSync(
      join(cli.dir, ".env"),
      `${cli.env()}LOG_LEVEL=debug
`,
    );

    rmSync(join(cli.state, "calls"), { force: true });
    const again = cli.run(["install", "--yes"]);
    expect(again.status).toBe(0);
    expect(cli.calls().some((c) => c.includes(" up -d"))).toBe(true);
  });

  it("repairs a stack with a service down, and that is not a no-op", () => {
    const cli = makeInstall();
    expect(cli.run(["install", "--yes"]).status).toBe(0);
    cli.flag("service-worker", "exited");
    const repair = cli.run(["install", "--yes"]);
    expect(repair.status).toBe(0);
    expect(repair.stdout).toContain("installed");
  });

  it("can simply be run again after being interrupted", () => {
    // The interruption modelled here is the one that actually happens:
    // the build dies after .env has been written. The secret from the
    // first attempt has to survive, or every session in a half-installed
    // product is signed out by the retry.
    const cli = makeInstall();
    cli.flag("up_fail", "build");
    const first = cli.run(["install", "--yes"]);
    expect(first.status).toBe(1);
    const secret = cli.envValue("BETTER_AUTH_SECRET");
    expect(secret.length).toBeGreaterThanOrEqual(32);

    cli.clearFlag("up_fail");
    const second = cli.run(["install", "--yes"]);
    expect(second.status).toBe(0);
    expect(cli.envValue("BETTER_AUTH_SECRET")).toBe(secret);
  });

  it("tells a build failure apart from a migration failure", () => {
    const build = makeInstall();
    build.flag("up_fail", "build");
    const buildResult = build.run(["install", "--yes"]);
    expect(buildResult.status).toBe(1);
    expect(buildResult.stderr).toContain("did not build");

    const migrate = makeInstall();
    migrate.flag("up_fail", "migrate");
    const migrateResult = migrate.run(["install", "--yes"]);
    expect(migrateResult.status).toBe(1);
    expect(migrateResult.stderr).toContain("migrations failed");
  });

  it("says the stack would not start when that is what happened", () => {
    // The third of the four ways an install fails, and the one with no
    // build log and no migration log to read: compose itself refused.
    const cli = makeInstall();
    cli.flag("up_fail", "start");
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not start the stack");
    expect(result.stderr).toContain("doctor");
  });

  it("fails when the app never becomes healthy, naming the endpoint it waited on", () => {
    const cli = makeInstall();
    cli.flag("app_ready", "0");
    const result = cli.run(["install", "--yes", "--timeout", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("/api/ready");
  });

  it("fails when the worker never schedules anything", () => {
    const cli = makeInstall();
    cli.flag("cron", "absent");
    const result = cli.run(["install", "--yes", "--timeout", "1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scheduler pass");
  });
});

describe("a customized stack", () => {
  it("refuses, because vigilctl would drive a different stack from docker compose", () => {
    const cli = makeInstall({ override: true });
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("docker-compose.override.yml");
    expect(cli.firstCall("up")).toBe(-1);
  });

  it("proceeds when the operator takes responsibility for it", () => {
    const cli = makeInstall({ override: true });
    const result = cli.run(["install", "--yes", "--allow-customized"]);
    expect(result.status).toBe(0);
  });

  it("refuses when the project is also running services it was not given", () => {
    // The commercial overlays share the base project name so the worker
    // can reach the runner by service name, which makes an install
    // running one of them a single stack that vigilctl holds only part
    // of. `up --build` would rebuild the app and the worker and leave
    // the runner on its old image without saying so.
    const cli = makeInstall();
    cli.markInstalled();
    cli.flag("extra_services", "synthetics");
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("synthetics");
    expect(cli.firstCall("up")).toBe(-1);
  });

  it("reports the same thing as a warning in doctor, which never refuses", () => {
    const cli = makeInstall();
    cli.run(["install", "--yes"]);
    cli.flag("migrations_applied", String(migrationCount));
    cli.flag("extra_services", "synthetics");
    const result = cli.run(["doctor"]);
    expect(result.status).toBe(10);
    expect(result.stdout).toContain("also running synthetics");
    expect(result.stdout).not.toContain("FAIL");
  });

  it("refuses an edited compose file inside a checkout", () => {
    const cli = makeInstall({ git: true });
    writeFileSync(
      join(cli.dir, "docker-compose.yml"),
      `${readFileSync(join(cli.dir, "docker-compose.yml"), "utf8")}\n# edited\n`,
    );
    const result = cli.run(["install", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("uncommitted changes");
  });
});

describe("doctor", () => {
  it("is clean on a healthy install, and exits 0", () => {
    const cli = makeInstall();
    cli.run(["install", "--yes"]);
    cli.flag("migrations_applied", String(migrationCount));
    const result = cli.run(["doctor"]);
    expect(result.stdout).toContain("healthy");
    expect(result.stdout).not.toContain("FAIL");
    if (posixModesAreKept()) {
      expect(result.status).toBe(0);
      return;
    }
    // A filesystem that will not keep `chmod 600` leaves doctor with the
    // one warning it cannot clear. Nothing else may warn.
    expect(result.status).toBe(10);
    expect(result.stdout).toContain(".env permissions");
    expect(result.stdout.match(/^ {2}warn/gm) ?? []).toHaveLength(1);
  });

  it("redacts every secret it reports", () => {
    const cli = makeInstall();
    cli.run(["install", "--yes"]);
    cli.flag("migrations_applied", String(migrationCount));
    const result = cli.run(["doctor"]);
    expect(result.output).not.toContain(cli.envValue("BETTER_AUTH_SECRET"));
    expect(result.output).not.toContain(cli.envValue("POSTGRES_PASSWORD"));
    expect(result.output).toMatch(
      /BETTER_AUTH_SECRET\s+set \(\d+ characters\)/,
    );
  });

  it("exits 10 for warnings alone", () => {
    const cli = makeInstall();
    cli.run(["install", "--yes"]);
    cli.flag("migrations_applied", String(migrationCount));
    writeFileSync(join(cli.dir, ".env"), `${cli.env()}DEMO_MODE=true\n`);
    const result = cli.run(["doctor"]);
    expect(result.status).toBe(10);
    expect(result.stdout).toContain("DEMO_MODE");
  });

  it("fails when migrations are pending", () => {
    const cli = makeInstall();
    cli.run(["install", "--yes"]);
    cli.flag("migrations_applied", String(migrationCount - 1));
    const result = cli.run(["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("migrations");
  });

  it("fails when the worker has stopped scheduling, which nothing else notices", () => {
    const cli = makeInstall();
    cli.run(["install", "--yes"]);
    cli.flag("migrations_applied", String(migrationCount));
    cli.flag("cron", "4000");
    const result = cli.run(["doctor"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scheduler pass");
  });

  it("changes nothing: no up, no stop, no restore", () => {
    const cli = makeInstall();
    cli.markInstalled();
    rmSync(join(cli.state, "calls"), { force: true });
    cli.run(["doctor"]);
    for (const forbidden of ["up ", "stop", "start", "run ", "pg_restore"]) {
      expect(cli.calls().some((call) => call.includes(forbidden))).toBe(false);
    }
  });
});

describe("backup", () => {
  it("writes an archive and says how many entries it holds", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const result = cli.run(["backup"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("archive entries");
    const backups = readdirSync(join(cli.dir, "backups")).filter((f) =>
      f.endsWith(".dump"),
    );
    expect(backups).toHaveLength(1);
  });

  it("refuses to pretend when the database is not running", () => {
    const cli = makeInstall();
    const result = cli.run(["backup"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not running");
  });

  it("keeps nothing when pg_dump exits 0 having written rubbish", () => {
    // The failure a backup script exists for. pg_dump can succeed and
    // leave a stream nothing can read back, and a file of plausible size
    // with a plausible name is worse than no file at all: nobody finds
    // out until the day they need it.
    const cli = makeInstall();
    cli.markInstalled();
    cli.flag("dump_corrupt", "1");
    const result = cli.run(["backup"]);
    expect(result.status).toBe(1);
    expect(
      readdirSync(join(cli.dir, "backups")).filter((f) => f.endsWith(".dump")),
    ).toHaveLength(0);
  });

  it("keeps nothing when the dump fails", () => {
    const cli = makeInstall();
    cli.markInstalled();
    cli.flag("dump_fail", "1");
    const result = cli.run(["backup"]);
    expect(result.status).toBe(1);
    const dir = join(cli.dir, "backups");
    const kept = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".dump"))
      : [];
    expect(kept).toHaveLength(0);
  });
});

describe("restore", () => {
  function withArchive(cli: Install, contents: string): string {
    const path = join(cli.dir, "archive.dump");
    writeFileSync(path, contents);
    return path;
  }

  it("rejects an archive that is not one, before stopping anything", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const archive = withArchive(cli, "this is a text file\n");
    const result = cli.run(["restore", posix(archive), "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a custom-format");
    expect(cli.firstCall("stop")).toBe(-1);
  });

  it("refuses without consent, and there is no terminal to ask on", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const archive = withArchive(cli, "PGDMP-stub-archive\n");
    const result = cli.run(["restore", posix(archive)]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("--yes");
    expect(cli.firstCall("stop")).toBe(-1);
  });

  it("dumps the current database before it destroys it", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const archive = withArchive(cli, "PGDMP-stub-archive\n");
    const result = cli.run(["restore", posix(archive), "--yes"]);
    expect(result.status).toBe(0);

    const safety = cli.firstCall("pg_dump");
    const stopped = cli.firstCall("stop");
    const restored = cli
      .calls()
      .findIndex((c) => /pg_restore(?!.*--list)/.test(c));
    expect(safety).toBeGreaterThan(-1);
    expect(safety).toBeLessThan(stopped);
    expect(stopped).toBeLessThan(restored);
    expect(result.stdout).toContain("pre-restore");
  });

  it("brings the schema up to the running build and verifies health afterwards", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const archive = withArchive(cli, "PGDMP-stub-archive\n");
    const result = cli.run(["restore", posix(archive), "--yes"]);
    expect(result.status).toBe(0);
    expect(cli.calls().some((c) => c.includes("run --rm migrate"))).toBe(true);
    expect(result.stdout).toContain("restored");
  });

  it("is not defeated by the errors a --clean pass always produces", () => {
    // pg-boss partitions `job` and `queue_stats`. A partition's
    // constraint cannot be dropped on the partition, dropping the parent
    // takes it anyway, and pg_restore ignores the failure, says "errors
    // ignored on restore: 3" and exits 1. Judged by exit code alone,
    // every --force restore of a real Vigil dump reported failure while
    // having restored everything correctly.
    const cli = makeInstall();
    cli.markInstalled();
    cli.flag("restore_partition_warnings", "1");
    const archive = join(cli.dir, "archive.dump");
    writeFileSync(archive, "PGDMP-stub-archive\n");

    const result = cli.run(["restore", posix(archive), "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("restored");
  });

  it("still fails on an error a --clean pass does not produce", () => {
    const cli = makeInstall();
    cli.markInstalled();
    cli.flag("restore_fail", "1");
    const archive = join(cli.dir, "archive.dump");
    writeFileSync(archive, "PGDMP-stub-archive\n");

    const result = cli.run(["restore", posix(archive), "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pre-restore");
  });

  it("names the dump it took when a step after the restore fails", () => {
    const cli = makeInstall();
    cli.markInstalled();
    cli.flag("migrate_fail", "1");
    const archive = withArchive(cli, "PGDMP-stub-archive\n");
    const result = cli.run(["restore", posix(archive), "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pre-restore");
  });
});

describe("update", () => {
  it("refuses to choose a version, and shows what is installed", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const result = cli.run(["update", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("never picks one for you");
  });

  it("refuses a ref this checkout does not have", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const result = cli.run(["update", "--to", "v9.9.9", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("not a tag, branch or commit");
  });

  it("refuses outside a git checkout, because there is nothing to move between", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const result = cli.run(["update", "--to", "next", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("not a git checkout");
  });

  it("refuses when tracked files are modified", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    writeFileSync(join(cli.dir, "RELEASE-NOTE.md"), "local edit\n");
    spawnSync("git", ["-C", cli.dir, "add", "-A"], { encoding: "utf8" });
    const result = cli.run(["update", "--to", "next", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("uncommitted changes");
  });

  it("is a no-op when the target is what is already installed", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const result = cli.run(["update", "--to", "main", "--yes"]);
    expect(result.status).toBe(10);
  });

  it("finishes an interrupted update instead of starting a new one", () => {
    // The state that made this necessary: the checkout has moved but the
    // build never landed, so the target commit IS HEAD while the old
    // images are still running. Comparing HEAD to the target alone would
    // call that a no-op and leave the installation half updated forever.
    //
    // Starting over would be worse than that. A second pass through the
    // fresh path would back up the half-migrated database and record
    // from_sha as the version being installed, and the way back would be
    // gone.
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const before = cli.git("rev-parse", "HEAD");

    cli.flag("up_fail", "migrate");
    expect(cli.run(["update", "--to", "next", "--yes"]).status).toBe(1);
    expect(cli.git("rev-parse", "HEAD")).not.toBe(before);
    const dumpsAfterFailure = readdirSync(join(cli.dir, "backups")).filter(
      (f) => f.startsWith("pre-update-"),
    );
    expect(dumpsAfterFailure).toHaveLength(1);

    cli.clearFlag("up_fail");
    const resumed = cli.run(["update", "--to", "next", "--yes"]);
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain("did not finish");

    const state = readFileSync(
      join(cli.dir, "backups", "vigilctl-rollback.state"),
      "utf8",
    );
    expect(state).toContain(`from_sha=${before}`);
    expect(state).toContain("stage=complete");
    expect(
      readdirSync(join(cli.dir, "backups")).filter((f) =>
        f.startsWith("pre-update-"),
      ),
    ).toHaveLength(1);
  });

  it("is a no-op the second time, once the first one finished", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    expect(cli.run(["update", "--to", "next", "--yes"]).status).toBe(0);
    expect(cli.run(["update", "--to", "next", "--yes"]).status).toBe(10);
  });

  it("refuses to update a stack that is already broken", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    cli.flag("app_ready", "0");
    const result = cli.run(["update", "--to", "next", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("not healthy");
  });

  it("backs up before it moves, and records what to go back to", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const before = cli.git("rev-parse", "HEAD");
    const result = cli.run(["update", "--to", "next", "--yes"]);
    expect(result.status).toBe(0);

    expect(cli.git("rev-parse", "HEAD")).not.toBe(before);
    const dumps = readdirSync(join(cli.dir, "backups")).filter((f) =>
      f.startsWith("pre-update-"),
    );
    expect(dumps).toHaveLength(1);

    const state = readFileSync(
      join(cli.dir, "backups", "vigilctl-rollback.state"),
      "utf8",
    );
    expect(state).toContain(`from_sha=${before}`);
    expect(state).toContain("dump=");
  });

  it("leaves the rollback record behind when the new version fails", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    cli.flag("up_fail", "migrate");
    const result = cli.run(["update", "--to", "next", "--yes"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rollback");
    expect(
      existsSync(join(cli.dir, "backups", "vigilctl-rollback.state")),
    ).toBe(true);
  });
});

describe("rollback", () => {
  it("refuses when there is no update to undo", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const result = cli.run(["rollback", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("no update to roll back");
  });

  it("refuses, without destroying anything, when the recorded dump is gone", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    expect(cli.run(["update", "--to", "next", "--yes"]).status).toBe(0);
    for (const file of readdirSync(join(cli.dir, "backups"))) {
      if (file.endsWith(".dump")) rmSync(join(cli.dir, "backups", file));
    }
    rmSync(join(cli.state, "calls"), { force: true });
    const result = cli.run(["rollback", "--yes"]);
    expect(result.status).toBe(20);
    expect(result.stderr).toContain("gone");
    expect(cli.firstCall("stop")).toBe(-1);
  });

  it("puts the code and the database back, then consumes the record", () => {
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    const before = cli.git("rev-parse", "HEAD");
    expect(cli.run(["update", "--to", "next", "--yes"]).status).toBe(0);
    expect(cli.git("rev-parse", "HEAD")).not.toBe(before);

    const result = cli.run(["rollback", "--yes"]);
    expect(result.status).toBe(0);
    expect(cli.git("rev-parse", "HEAD")).toBe(before);
    expect(
      existsSync(join(cli.dir, "backups", "vigilctl-rollback.state")),
    ).toBe(false);

    // And a second one has nothing left to do.
    expect(cli.run(["rollback", "--yes"]).status).toBe(20);
  });

  it("checks the code out before it restores, never the other way round", () => {
    // The old code has to be in place before the old database is, or
    // there is a window where a running worker writes rows against a
    // schema that is about to be replaced.
    const cli = makeInstall({ git: true });
    cli.markInstalled();
    expect(cli.run(["update", "--to", "next", "--yes"]).status).toBe(0);
    rmSync(join(cli.state, "calls"), { force: true });
    expect(cli.run(["rollback", "--yes"]).status).toBe(0);

    const stopped = cli.firstCall("stop");
    const restored = cli
      .calls()
      .findIndex((c) => /pg_restore(?!.*--list)/.test(c));
    expect(stopped).toBeGreaterThan(-1);
    expect(stopped).toBeLessThan(restored);
  });
});

describe("archives are read by the binary that wrote them", () => {
  /**
   * Never by whatever the host happens to have.
   *
   * Every archive vigilctl handles was written by the pg_dump inside
   * this stack, and only a pg_restore of at least that version can parse
   * it. A host client is frequently older: the CI runner ships
   * PostgreSQL 16 while the stack runs 18, and the first version of this
   * code preferred the host whenever it had one. A perfectly good backup
   * was reported unreadable and deleted, on the one deployment the
   * script documents.
   *
   * These pin the reader by the call the stub recorded, which is the
   * only thing that would catch the preference coming back: an exit code
   * alone cannot tell the two branches apart.
   */
  const listedInContainer = (cli: Install) =>
    cli.calls().some((c) => c.includes("exec -T postgres pg_restore --list"));

  it("lists a real archive through the container", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const archive = join(cli.dir, "good.dump");
    writeFileSync(archive, "PGDMP-stub-archive\n");

    const result = runShell(
      cli,
      [
        SOURCE_LIBS,
        `archive_lists '${posix(archive)}' || exit 1`,
        `archive_entries '${posix(archive)}'`,
      ].join("\n"),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2");
    expect(listedInContainer(cli)).toBe(true);
  });

  it("says no to a file that is not an archive, through the same path", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const archive = join(cli.dir, "bad.dump");
    writeFileSync(archive, "this is a text file\n");

    const result = runShell(
      cli,
      [SOURCE_LIBS, `archive_lists '${posix(archive)}'`].join("\n"),
    );
    expect(result.status).not.toBe(0);
    expect(listedInContainer(cli)).toBe(true);
  });

  it("validates what scripts/backup.sh wrote through the container too", () => {
    const cli = makeInstall();
    cli.markInstalled();
    const out = join(cli.dir, "backups", "from-script.dump");

    const result = runShell(
      cli,
      `bash scripts/backup.sh --docker -o '${posix(out)}'`,
    );
    expect(`${result.stdout}${result.stderr}`).toContain("archive entries");
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(listedInContainer(cli)).toBe(true);
  });
});

describe("what Core receives", () => {
  const sources = [
    "vigilctl",
    ...readdirSync(join(ROOT, "scripts", "vigilctl")).map((f) =>
      join("scripts", "vigilctl", f),
    ),
  ];

  it("carries no commercial marker, so the strip leaves all of it", () => {
    for (const file of sources) {
      const first = readFileSync(join(ROOT, file), "utf8").split("\n")[0];
      expect(first).not.toContain("@edition:ee");
    }
  });

  /**
   * A shell file with its comment lines removed.
   *
   * The checks below are about what the CLI reaches for, and a comment
   * reaches for nothing. Explaining why the synthetics overlay makes an
   * install unmanageable requires naming the overlay, and a check that
   * read the explanation as a dependency would be answered by deleting
   * the explanation, which is the wrong way to make a guard green.
   *
   * Whole lines only. A trailing comment after code is kept, so a real
   * reference cannot hide behind a `#` on the same line.
   */
  const codeOf = (file: string) =>
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

  it("names no file the free edition does not have", () => {
    // Every one of these is removed from the mirror by name in
    // scripts/edition-gate.sh. A CLI that reached for one of them would
    // work here and fail in Core, which is the failure this repository
    // keeps having.
    const commercialOnly = [
      "docker-compose.synthetics.yml",
      "docker-compose.probes.yml",
      "Dockerfile.synthetics",
      "Dockerfile.probe",
      "scripts/release",
      "scripts/publish-core.sh",
      "docs/SLOS.md",
      "docs/RUNBOOKS.md",
      "docs/TASKS.md",
      "docs/REMOTE-PROBES.md",
      "docs/SYNTHETICS.md",
      "docs/MAINTENANCE.md",
      "docs/ALERT-ROUTING.md",
      "docs/SCALING.md",
      "worker_nodes",
    ];
    for (const file of sources) {
      const source = codeOf(file);
      for (const name of commercialOnly) {
        expect(`${file}: ${source.includes(name) ? name : ""}`).toBe(
          `${file}: `,
        );
      }
    }
  });

  it("depends on nothing but bash and Docker", () => {
    // No npm, no tsx, no psql on the host. The machine that runs the
    // supported install has Docker on it and frequently nothing else,
    // and a lifecycle CLI that needed the toolchain would be unusable
    // exactly where it is needed.
    for (const file of sources) {
      const source = codeOf(file);
      expect(source).not.toMatch(/\bnpm (run|ci|install)\b/);
      expect(source).not.toMatch(/\bnpx\b/);
      expect(source).not.toMatch(/\btsx\b/);
    }
  });

  it("is committed executable, so a clone can run it", () => {
    const inRepo = spawnSync(
      "git",
      ["-C", ROOT, "rev-parse", "--is-inside-work-tree"],
      {
        encoding: "utf8",
      },
    );
    if ((inRepo.stdout ?? "").trim() === "true") {
      const mode = spawnSync(
        "git",
        ["-C", ROOT, "ls-files", "-s", "vigilctl"],
        {
          encoding: "utf8",
        },
      );
      expect(mode.stdout.trim()).toMatch(/^100755 /);
      return;
    }
    // The exported Core tree is a plain directory, not a checkout, so
    // the mode cannot be asked of git there. What can be asked is that
    // the file arrived at all and is a bash program.
    const source = readFileSync(join(ROOT, "vigilctl"), "utf8");
    expect(source.split("\n")[0]).toBe("#!/usr/bin/env bash");
  });
});

describe("the shell itself", () => {
  let bashAvailable = true;

  beforeAll(() => {
    bashAvailable = spawnSync("bash", ["--version"]).status === 0;
  });

  it("parses under bash strict mode, every file", () => {
    expect(bashAvailable).toBe(true);
    for (const file of [
      "vigilctl",
      ...readdirSync(join(ROOT, "scripts", "vigilctl")).map((f) =>
        join("scripts", "vigilctl", f),
      ),
    ]) {
      const result = spawnSync("bash", ["-n", posix(join(ROOT, file))], {
        encoding: "utf8",
      });
      expect(`${file}: ${result.stderr}`).toBe(`${file}: `);
      expect(result.status).toBe(0);
    }
  });
});
