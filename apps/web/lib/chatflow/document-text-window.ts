/** Bound highlighted/Markdown DOM independently of the authenticated read size. */
export const textRenderLimits = { lines: 200, characters: 16_000 } as const;

export function documentTextWindows(text: string): string[] {
  const pages: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + textRenderLimits.characters, text.length);
    // Do not split a Unicode surrogate pair at the character budget.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    let cursor = start;
    for (let line = 0; line < textRenderLimits.lines; line++) {
      const newline = text.indexOf('\n', cursor);
      if (newline < 0 || newline >= end) break;
      cursor = newline + 1;
      if (line === textRenderLimits.lines - 1) end = cursor;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages.length ? pages : [''];
}
