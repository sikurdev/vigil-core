/** Shared, inert navigation for captured product pages and the evidence example. */
export const TOUR_SUCCESS =
  "/demo/incidents/01a03093-8f2c-724a-bdac-d533f517ddf4.html";
export const TOUR_EXHAUSTED =
  "/demo/incidents/01a03093-8f2a-719a-a396-156cf35d4b53.html";
export const TOUR_RECORD =
  "/demo/monitors/01a03093-7244-7051-b0ee-e42e44fbfcb8.html";
export const TOUR_EVIDENCE = "/demo/evidence-example.html";

export function renderTourBar(route: string): string {
  const success = route === TOUR_SUCCESS || route === TOUR_RECORD;
  const exhausted = route === TOUR_EXHAUSTED;
  const evidence = route === TOUR_EVIDENCE;
  const step = success ? 1 : exhausted ? 2 : evidence ? 3 : null;
  const next = success
    ? TOUR_EXHAUSTED
    : exhausted
      ? TOUR_EVIDENCE
      : evidence
        ? "/demo/tour-complete.html"
        : "/demo/";
  const nextLabel = success
    ? "Next: limits →"
    : exhausted
      ? "Next: evidence →"
      : evidence
        ? "Finish tour →"
        : "Start tour →";
  const notice = evidence
    ? "Test data. Read-only example."
    : "Sample data. Actions are disabled.";
  return (
    '<aside class="vigil-tour" aria-label="Product tour">' +
    `<div><strong>${step ? `${step} of 3 · ` : ""}Read-only tour</strong><small>${notice}</small></div>` +
    `<a class="vigil-tour-next" href="${next}">${nextLabel}</a>` +
    '<details class="vigil-tour-menu"><summary aria-label="Tour navigation and exit">More</summary>' +
    '<nav aria-label="Tour navigation"><strong>Guided walkthrough</strong>' +
    `<a href="${TOUR_SUCCESS}">1 · Verified recovery</a><a href="${TOUR_EXHAUSTED}">2 · Recovery limits</a>` +
    `<a href="${TOUR_EVIDENCE}">3 · Incident evidence example</a><a href="/demo/tour-complete.html">Walkthrough complete</a>` +
    '<strong>Explore freely</strong><a href="/demo/dashboard.html">Dashboard</a><a href="/demo/incidents.html">Incidents</a>' +
    '<a href="/demo/runbooks.html">Runbooks</a><a href="/demo/slos.html">Objectives</a>' +
    '<a href="/demo/tour-notes.html">About this capture</a><a href="/">Back to Vigil</a>' +
    '<a href="/pricing/">Pricing &amp; editions</a></nav></details></aside>'
  );
}
