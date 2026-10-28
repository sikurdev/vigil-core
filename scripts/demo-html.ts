/** Byte-preserving ranges for the known server-rendered demo markup. */
export function elementRange(html: string, start: number, tag: string) {
  if (start < 0 || !html.slice(start).startsWith(`<${tag}`)) {
    throw new Error(`Expected <${tag}> at the requested demo range`);
  }
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, "g");
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return {
        start,
        end: tags.lastIndex,
        html: html.slice(start, tags.lastIndex),
      };
    }
  }
  throw new Error(`Unclosed <${tag}> in captured demo markup`);
}
