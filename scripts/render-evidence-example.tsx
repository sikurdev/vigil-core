/**
 * Render the real evidence card without starting Next, a worker, or a database.
 * Run from the repository root: TZ=UTC npx tsx scripts/render-evidence-example.tsx
 * The published data is an explicitly labelled composite of existing test cases.
 * Fixture extraction fails closed if those cases change shape.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { renderTourBar, TOUR_EVIDENCE } from "./demo-tour-frame";

import { IncidentEvidenceCard } from "../src/app/(app)/incidents/[id]/evidence-card";
import { classifyStage } from "../src/modules/incidents/evidence/classify";
import { meaningfulChanges } from "../src/modules/incidents/evidence/diff";
import type {
  BurstRecord,
  IncidentEvidenceSnapshot,
} from "../src/modules/incidents/evidence/types";

if (Intl.DateTimeFormat().resolvedOptions().timeZone !== "UTC") {
  throw new Error(
    "Render this fixture with TZ=UTC so provenance and dates agree.",
  );
}
const root = resolve(import.meta.dirname, "..");
const demoOut = process.env.VIGIL_DEMO_OUTPUT ?? "landing/demo";
function sourceCommit(): string {
  let commit: string | undefined;
  try {
    const git = (args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    // Do not attribute an exported source tree to an enclosing workspace repo.
    if (resolve(git(["rev-parse", "--show-toplevel"])) === root) {
      commit = git(["rev-parse", "--verify", "HEAD"]);
    }
  } catch {
    // Verified source materializations may intentionally have no .git directory.
  }
  commit ??= process.env.VIGIL_EVIDENCE_SOURCE_COMMIT?.trim();
  if (!commit || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(commit)) {
    throw new Error(
      "Cannot establish the evidence source commit. Run in the Vigil Git checkout, or set VIGIL_EVIDENCE_SOURCE_COMMIT to the full verified commit hash for this source materialization.",
    );
  }
  return commit.toLowerCase();
}
const verifiedSourceCommit = sourceCommit();
const unitPath = "tests/unit/incident-evidence.test.ts";
const componentPath = "src/app/(app)/incidents/[id]/evidence-card.tsx";
const source = readFileSync(resolve(root, unitPath), "utf8");
const ast = ts.createSourceFile(unitPath, source, ts.ScriptTarget.Latest, true);
function evaluate<T>(code: string): T {
  const js = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return runInNewContext(js, {}, { timeout: 1000 }) as T;
}
function declaration(name: string): string {
  const node = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!node) throw new Error(`Missing fixture function: ${name}`);
  return node.getText(ast);
}
const snapshot = evaluate<IncidentEvidenceSnapshot>(
  `${declaration("snapshot")}\nsnapshot();`,
);
let diagnosticSteps: BurstRecord["steps"] | undefined;
let priorResponseTime: number | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "it") {
    const title = node.arguments[0];
    if (title && ts.isStringLiteral(title)) {
      const body = node.arguments[1];
      if (
        title.text ===
        "upgrades a timeout to a measured layer when the burst reproduced it"
      ) {
        function findBurst(child: ts.Node) {
          if (
            ts.isCallExpression(child) &&
            child.expression.getText(ast) === "burst"
          ) {
            diagnosticSteps = evaluate(
              `(${child.arguments[0]!.getText(ast)});`,
            );
          }
          ts.forEachChild(child, findBurst);
        }
        if (body) findBurst(body);
      }
      if (
        title.text === "ignores response-time noise and reports a real slowdown"
      ) {
        function findBefore(child: ts.Node) {
          if (
            ts.isCallExpression(child) &&
            child.expression.getText(ast) === "meaningfulChanges"
          ) {
            priorResponseTime = evaluate<{ responseTimeMs: number }>(
              `(${child.arguments[0]!.getText(ast)});`,
            ).responseTimeMs;
          }
          ts.forEachChild(child, findBefore);
        }
        if (body) findBefore(body);
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!diagnosticSteps || priorResponseTime !== 130)
  throw new Error(
    "Evidence test fixtures changed; review the composite before rebuilding.",
  );
const burst = evaluate<BurstRecord>(
  `const BURST_MAX_STEPS = 4;\n${declaration("burst")}\nburst(${JSON.stringify(diagnosticSteps)});`,
);
// Explicit reconstruction: align the independently authored test timestamps and
// total the literal step durations. Neither timing is a product benchmark.
const priorAt = burst.ranAt;
burst.ranAt = snapshot.capturedAt;
burst.spentMs = diagnosticSteps.reduce((sum, step) => sum + step.durationMs, 0);
snapshot.burst = burst;
snapshot.stage = classifyStage(snapshot.failure, burst);
snapshot.lastSuccess = {
  at: priorAt,
  verdict: "up",
  failureClass: null,
  error: null,
  statusCode: null,
  responseTimeMs: priorResponseTime,
  failedAssertions: [],
  facts: { responseTimeMs: priorResponseTime },
};
snapshot.lastSuccessNote = "found";
snapshot.changes = meaningfulChanges(
  snapshot.lastSuccess.facts,
  snapshot.failure.facts,
  [
    {
      key: "responseTimeMs",
      label: "Response time",
      kind: "number",
      unit: "ms",
    },
  ],
);

const hashes = [
  componentPath,
  unitPath,
  "src/components/ui/card.tsx",
  "src/components/ui/badge.tsx",
  "src/app/globals.css",
  "src/modules/incidents/evidence/classify.ts",
  "src/modules/incidents/evidence/diff.ts",
].map((path) => {
  const bytes = readFileSync(resolve(root, path));
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    gitBlobSha: createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex"),
  };
});
const provenance = {
  kind: "Repository test-fixture composite; explanatory reconstruction, not a live incident or performance result",
  sourceCommit: verifiedSourceCommit,
  generator: "scripts/render-evidence-example.tsx",
  component: componentPath,
  sourceFiles: hashes,
  fixtureCases: [
    "snapshot() storage-bound fixture",
    "upgrades a timeout to a measured layer when the burst reproduced it",
    "ignores response-time noise and reports a real slowdown",
  ],
  reconstruction: [
    "Unchanged timeout snapshot is combined with the measured TCP-refusal diagnostic steps from the existing unit test.",
    "The 130 ms previous response is taken from the existing before/after test. Its illustrative timestamp uses the earlier timestamp from the burst fixture; no previous status is asserted.",
    "The diagnostic timestamp is aligned with the snapshot; total duration is the sum of its fixture steps. Values are illustrative test inputs, not measured performance.",
    "Stage and before/after changes are derived by the actual product classifyStage and meaningfulChanges functions. No probes or database operations run.",
  ],
  timezone: "UTC",
};
const evidence = {
  incidentId: "repository-fixture-composite",
  capturedAt: new Date(snapshot.capturedAt),
  schemaVersion: snapshot.schemaVersion,
  snapshot,
};
const card = renderToStaticMarkup(<IncidentEvidenceCard evidence={evidence} />);
const payload = JSON.stringify({ provenance, evidence }, null, 2);
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const html = `<!doctype html>
<html lang="en" class="dark" style="color-scheme:dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Evidence interface example | Vigil</title><link rel="stylesheet" href="/demo/evidence-example.css"><link rel="stylesheet" href="/demo/tour.css"></head>
<body class="evidence-example-page"><main class="example-shell"><nav aria-label="Example navigation"><a href="/evidence/">← Incident evidence</a><a href="/demo/">Product tour</a></nav>
<header><p class="eyebrow">Vigil / Product interface / Walkthrough 3 of 3</p><h1>Evidence interface example</h1><p>See what failed, what changed and which layer the onset diagnostics established.</p></header>
<section class="fixture-notice" aria-label="Sample provenance"><strong>Illustrative sample using test data</strong><p>Not a live incident or performance result.</p><a href="#sample-data">Inspect sample details ↓</a></section>
<section id="evidence-card" aria-label="Actual Vigil evidence component">${card}</section>
<section class="explanation"><h2>Read the evidence in order</h2><ol><li><strong>Reported error:</strong> the original check timed out; the error alone does not identify a layer.</li><li><strong>Measured connection failure:</strong> the diagnostic reached DNS, then encountered a refused TCP connection.</li><li><strong>Before and after:</strong> the reconstructed previous response was 130 ms; the failed check reached its 10,000 ms timeout. These are test inputs.</li></ol><p>There is no recovery outcome in this example. Onset diagnostics do not prove recovery or identify a root cause beyond what they directly observe.</p></section>
<section id="sample-data" class="sample-data"><h2>Inspect the source</h2><p>The input below includes fixture cases, source hashes and reconstruction notes. <a href="/demo/evidence-example.json">Open full JSON</a>.</p><details><summary>Show the complete input and provenance</summary><p>Repository test-fixture composite: this explanatory reconstruction uses Vigil’s unchanged evidence component. The previous response and diagnostic steps come from separate repository tests; the full input records the source files, hashes and exact reconstruction choices.</p><pre tabindex="0" aria-label="Sample input JSON">${escape(payload)}</pre></details></section>
<footer><a href="/demo/tour-complete.html">Finish the walkthrough →</a><a href="/evidence/">Explore incident evidence →</a><span>Vigil by Sikur · Read-only example</span></footer></main>${renderTourBar(TOUR_EVIDENCE)}</body></html>`;

async function main() {
  const css = await postcss([
    tailwindcss({ base: root, optimize: true }),
  ]).process(
    '@import "../src/app/globals.css";\n@source "../src/app/(app)/incidents/[id]/evidence-card.tsx";\n@source "../src/components/ui/card.tsx";\n@source "../src/components/ui/badge.tsx";\n@import "./evidence-example-shell.css";',
    { from: resolve(root, "scripts/evidence-example.generated.css") },
  );
  writeFileSync(resolve(root, `${demoOut}/evidence-example.html`), html);
  writeFileSync(
    resolve(root, `${demoOut}/evidence-example.fragment.html`),
    `<section id="evidence-card" aria-label="Actual Vigil evidence component">${card}</section>\n`,
  );
  writeFileSync(
    resolve(root, `${demoOut}/evidence-example.json`),
    payload + "\n",
  );
  writeFileSync(resolve(root, `${demoOut}/evidence-example.css`), css.css);
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/render-tour-excerpts.ts"],
    { cwd: root, stdio: "inherit" },
  );
  console.log(
    `Rendered unchanged ${componentPath}; sample fixture and provenance emitted. No network probes or database calls.`,
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
