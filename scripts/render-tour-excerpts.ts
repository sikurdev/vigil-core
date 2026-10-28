/** Native read-only excerpts copied from captured product markup, never mocked. */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { elementRange } from "./demo-html";

const root = resolve(import.meta.dirname, "..");
const demoOut = process.env.VIGIL_DEMO_OUTPUT ?? "landing/demo";
const out = resolve(root, demoOut, "excerpts");
const successPath =
  "landing/demo/incidents/01a03093-8f2c-724a-bdac-d533f517ddf4.html";
const settingsPath =
  "landing/demo/monitors/01a03093-78ec-7055-83f5-f683ef46155e.html";
const evidencePath = "landing/demo/evidence-example.fragment.html";
const read = (path: string) =>
  readFileSync(
    resolve(root, path.replace(/^landing\/demo(?=\/)/, demoOut)),
    "utf8",
  );
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const success = read(successPath);
const settings = read(settingsPath);
const evidence = read(evidencePath).trim();
const timelineStart =
  /<section\b[^>]*aria-label="Incident timeline"[^>]*>/.exec(success)?.index;
if (timelineStart === undefined)
  throw new Error("Missing genuine incident timeline");
const timeline = elementRange(success, timelineStart, "section").html;
const listStart = timeline.indexOf("<ol");
const list = elementRange(timeline, listStart, "ol").html;
const listOpen = list.slice(0, list.indexOf(">") + 1);
const eventFragments: string[] = [];
let cursor = listOpen.length;
for (let index = 0; index < 3; index++) {
  const event = elementRange(list, list.indexOf("<li", cursor), "li");
  eventFragments.push(event.html);
  cursor = event.end;
}
if (
  !eventFragments[0]!.includes(
    "Auth Service recovered, incident auto-resolved.",
  ) ||
  !eventFragments[1]!.includes(
    "Recovery verified. Auth Service is responding again after attempt 1.",
  ) ||
  !eventFragments[2]!.includes(
    "Automatic recovery attempt 1 of 2 started for Auth Service.",
  )
) {
  throw new Error(
    "Verified recovery fixture changed; review its actual recorded outcome before rebuilding.",
  );
}
const verified =
  timeline.slice(0, listStart) +
  listOpen +
  eventFragments.join("") +
  "</ol></section>";
const fieldAt = settings.indexOf('id="recovery-max-attempts"');
const gridAt = settings.lastIndexOf(
  '<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">',
  fieldAt,
);
const controls = elementRange(settings, gridAt, "div").html;
const inputTags = controls.match(/<input\b[^>]*>/g) ?? [];
if (
  inputTags.length !== 3 ||
  inputTags.some((tag) => !/\sdisabled(?:\s|=|>)/.test(tag)) ||
  !controls.includes('id="recovery-cooldown"') ||
  !controls.includes('id="recovery-verify-delay"') ||
  /recovery-secret|recovery-url|<form\b/.test(controls)
) {
  throw new Error(
    "Recovery-settings excerpt must contain only the three original disabled limit fields.",
  );
}
function productStyle(source: string) {
  const href =
    /<link\b[^>]*href="(\/demo\/_next\/static\/chunks\/[^"?]+\.css)"/.exec(
      source,
    )?.[1];
  const classes = /<html\b[^>]*class="([^"]+)"/.exec(source)?.[1];
  if (!href || !classes)
    throw new Error("Missing captured product CSS or font classes");
  return {
    href,
    classes:
      "dark " +
      classes
        .replace(/\b(?:h-full|light|dark)\b/g, "")
        .replace(/\s+/g, " ")
        .trim(),
  };
}
const variants = [
  {
    name: "verified-recovery",
    title: "Verified recovery · recorded sample",
    sourcePath: successPath,
    sourceRoute: successPath.replace("landing", "") + "#incident-timeline",
    sourceMarkup: success,
    fragment: verified,
    parts: eventFragments,
    kind: "Original recorded sample: first three timeline events, in their original order",
    style: productStyle(success),
  },
  {
    name: "recovery-settings",
    title: "Recovery limits · recorded sample",
    sourcePath: settingsPath,
    sourceRoute:
      settingsPath.replace("landing", "") + "#recovery-configuration",
    sourceMarkup: settings,
    fragment: controls,
    parts: [controls],
    kind: "Original recorded sample: the three disabled recovery-limit fields and their help text",
    style: productStyle(settings),
  },
  {
    name: "incident-evidence",
    title: "Incident evidence · illustrative test data",
    sourcePath: evidencePath,
    sourceRoute: "/demo/evidence-example.html#evidence-card",
    sourceMarkup: read(evidencePath),
    fragment: evidence,
    parts: [evidence],
    kind: "Actual current evidence component with disclosed test-fixture composite; see evidence-example.json",
    style: { href: "/demo/evidence-example.css", classes: "dark" },
  },
];
mkdirSync(out, { recursive: true });
for (const variant of variants) {
  const html = `<!doctype html><html lang="en" class="${variant.style.classes}" style="color-scheme:dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${variant.title} | Vigil</title><link rel="stylesheet" href="${variant.style.href}"><link rel="stylesheet" href="/demo/excerpts/excerpt.css"><script src="/demo/excerpts/resize.js" defer></script></head><body><main id="excerpt-content" aria-label="Read-only sample product excerpt">${variant.fragment}</main></body></html>`;
  writeFileSync(resolve(out, `${variant.name}.html`), html);
}
copyFileSync(
  resolve(root, "scripts/demo-excerpt.css"),
  resolve(out, "excerpt.css"),
);
copyFileSync(
  resolve(root, "scripts/demo-excerpt-resize.js"),
  resolve(out, "resize.js"),
);
writeFileSync(
  resolve(out, "provenance.json"),
  JSON.stringify(
    {
      generator: "scripts/render-tour-excerpts.ts",
      method:
        "Native HTML subsets copied byte-for-byte from actual product export/component fragments, using original CSS and fonts. Supported native dark theme and outer padding; disabled values use full opacity for read-only legibility. No original event text, values, control attributes or classes changed.",
      sampleData: true,
      mutationsEnabled: false,
      originalExportCommit: JSON.parse(
        read("landing/demo/export.manifest.json"),
      ).sourceCommit,
      evidenceProvenance: "/demo/evidence-example.json",
      excerpts: variants.map((v) => ({
        path: `/demo/excerpts/${v.name}.html`,
        sourcePath: v.sourcePath,
        sourceRoute: v.sourceRoute,
        kind: v.kind,
        sourceSha256: sha(v.sourceMarkup),
        excerptSha256: sha(v.fragment),
        copiedPartSha256: v.parts.map(sha),
        stylesheet: v.style.href,
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Generated three native read-only excerpts from original product markup.",
);
