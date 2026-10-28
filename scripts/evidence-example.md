# Evidence interface example

The seeded product tour does not contain a complete incident-evidence snapshot. This independent static example renders the actual `IncidentEvidenceCard` with React server rendering, without starting Next, connecting to a database, or running probes.

The demo exporter automatically rebuilds this final walkthrough stop after capturing the product pages. To rebuild it independently from the repository root after dependency installation:

```sh
TZ=UTC npx tsx scripts/render-evidence-example.tsx
npx prettier --write landing/demo/evidence-example.html landing/demo/evidence-example.fragment.html landing/demo/evidence-example.json landing/demo/evidence-example.css
```

The generator records the Vigil checkout's actual Git HEAD. For a source materialization without Git metadata, supply `VIGIL_EVIDENCE_SOURCE_COMMIT` with the full commit hash independently verified against that source. For example, prefix the generation command with `VIGIL_EVIDENCE_SOURCE_COMMIT=<verified-full-commit-hash>`. The override is used only when this directory is not a usable Vigil Git checkout; it cannot replace an available checkout HEAD. Generation fails clearly if neither source is available or the supplied hash is malformed. An enclosing workspace repository is not treated as Vigil's checkout.

No additional product dependencies are required. The generator uses React, TypeScript, Tailwind/PostCSS and Prettier already supplied by the repository dependency tree. The reconstruction deliberately combines existing unit-test cases: the complete timeout snapshot, measured connection-refusal diagnostic steps, and a previous response-time value. It is labelled before the product UI, in the input JSON and in the source provenance. It is not an exported customer incident, newly measured monitoring result or performance benchmark.

Stage classification and meaningful changes use the unchanged product functions. The renderer imports the actual evidence card, shared Badge/Card components and formatting code. Generated CSS compiles the existing product globals and components; the separate shell stylesheet only styles the explanatory document. Local product fonts are reused. The page and native excerpts explicitly select the product’s supported `.dark` theme; component markup and semantic colors remain native, without inversion or recolored screenshots.

Outputs:

- `/demo/evidence-example.html`: inspectable page, explicitly noindex.
- `/demo/evidence-example.html#evidence-card`: direct link to the product interface.
- `/demo/evidence-example.json`: full input, fixture-case descriptions, reconstruction details, source commit, SHA-256 and Git blob hashes.
- `/demo/evidence-example.fragment.html`: actual component HTML for embedding, requiring the generated product CSS. Preserve the fixture notice when embedding.
- `/demo/evidence-example.css`: generated product and explanatory-shell CSS.

The generator requires UTC, fails when fixture extraction no longer matches the expected cases, and records source hashes. Public-surface tests verify those hashes and require regeneration whenever a contributing source changes. The copied fixture dates and timings are illustrative test values. The diagnostic total is the sum of the literal step durations; its timestamp is aligned with the snapshot. The earlier fixture timestamp supplies the reconstructed previous success. No prior HTTP status is asserted.

The guided product-tour targets preserve published paths. `scripts/demo-route-aliases.json` binds all previously published dynamic URLs to named seed scenarios; duplicate incident names use their actual recovery-result summary, and run/task duplicates use their state. The exporter resolves exactly one current record per alias and confirms it is among the app's discovered routes. Missing or ambiguous matches fail closed. The manifest records each alias's actual captured route; it does not claim fresh database IDs remained unchanged.

A full export builds in an adjacent staging directory and replaces `landing/demo` only after product capture, required assets, evidence and excerpts succeed. A failed run leaves the last working tour intact. For a source materialization, `VIGIL_SOURCE_COMMIT=<verified-full-commit-hash> npm run demo:export` records that verified source and passes it to the evidence generator. Standard Git checkouts keep the ordinary command. `VIGIL_DEMO_OUTPUT` optionally selects a review directory without replacing the public tour.

## Native marketing excerpts

After rendering the evidence example, the generator runs `scripts/render-tour-excerpts.ts`. That source copies the first three original Auth Service timeline events, the three original disabled Checkout recovery-limit fields, and the actual generated evidence component fragment into `demo/excerpts/`. It preserves the copied HTML tags, classes, text and values. The pages load product CSS/fonts and a small frame stylesheet; the disabled controls retain their attributes while their values use full opacity for readability. No endpoint or signing-secret field is included.

`demo/excerpts/provenance.json` records source routes, source hashes and exact copied-part hashes. The standalone pages are noindex. `scripts/demo-excerpt-resize.js` sizes `#excerpt-content` using its bounding rectangle; it reports only to the same-origin parent and accepts measurement requests only from that parent. The exporter calls the evidence generator, so a full export rebuilds these excerpts too. They require the narrowly scoped same-origin framing exception in `landing/vercel.json`; all existing routes retain their original frame denial.

The guided incident pages use `presentTourIncident` from the exporter to put the original timeline first. The empty disabled postmortem remains available in a clearly labelled tour-only disclosure. All recorded event data and original form markup remain intact; the notes and export manifest disclose this presentation-only ordering.
