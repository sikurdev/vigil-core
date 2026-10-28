/* Size the intrinsic content, not the iframe viewport, to avoid feedback. */
(() => {
  function report() {
    const content = document.getElementById("excerpt-content");
    if (!content || window.parent === window) return;
    window.parent.postMessage(
      {
        type: "vigil:excerpt-size",
        height: Math.ceil(content.getBoundingClientRect().height),
      },
      window.location.origin,
    );
  }
  function observe() {
    const content = document.getElementById("excerpt-content");
    if (!content) return;
    new ResizeObserver(report).observe(content);
    report();
    if (document.fonts) document.fonts.ready.then(report);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe, { once: true });
  } else {
    observe();
  }
  window.addEventListener("load", report);
  window.addEventListener("resize", report);
  window.addEventListener("message", (event) => {
    if (
      event.origin === window.location.origin &&
      event.source === window.parent &&
      event.data?.type === "vigil:excerpt-measure"
    ) {
      report();
    }
  });
})();
