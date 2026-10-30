function sliceText(text: string, maximum: number, onTruncate?: () => void) {
  if (text.length > maximum) onTruncate?.();
  return text.slice(0, maximum);
}

export function shortText(
  value: unknown,
  maximum = 240,
  onTruncate?: () => void,
) {
  return typeof value === 'string' && value.trim()
    ? sliceText(value.trim(), maximum, onTruncate)
    : undefined;
}

/**
 * DSH may stream private reasoning before the user-visible answer. Do not
 * release any partial `<think>` prefix or body to ChatFlow.
 */
export function visibleModelText(text: string) {
  const candidate = text.trimStart();
  if ('<think>'.startsWith(candidate)) {
    return { ready: false, text: '' };
  }
  if (!candidate.startsWith('<think>')) {
    return { ready: true, text };
  }
  const closingTag = candidate.indexOf('</think>');
  if (closingTag === -1) {
    return { ready: false, text: '' };
  }
  return {
    ready: true,
    text: candidate.slice(closingTag + '</think>'.length).trimStart(),
  };
}

/** Reuse native task descriptions and known display fields, not command/code bodies. */
export function toolActivityDetail(
  name: string,
  args: Record<string, unknown> | null,
  onTruncate?: () => void,
) {
  if (!args) return undefined;
  let truncated = false;
  const clipped = () => {
    truncated = true;
  };
  const shown = (value: string) => {
    if (truncated) onTruncate?.();
    return value;
  };
  const symbol = shortText(args.symbol, 32, clipped);
  if (name === 'market.quote' && symbol)
    return shown(`查询 ${symbol} 的实时行情`);
  if (name === 'market.history' && symbol)
    return shown(`分析 ${symbol} 的历史走势`);
  truncated = false;
  if (/search/.test(name)) {
    const query =
      shortText(args.query, 100, clipped) ??
      (Array.isArray(args.queries)
        ? sliceText(
            args.queries.filter((x) => typeof x === 'string').join('、'),
            100,
            clipped,
          )
        : undefined);
    if (query) return shown(`搜索资料：${query}`);
  }
  if (/read|write|export|edit|changeset|list/.test(name)) {
    const path = shortText(
      args.fileName ?? args.path ?? args.file_path ?? args.relativePath,
      500,
      clipped,
    );
    const file = path?.split(/[\\/]/).filter(Boolean).at(-1);
    if (file)
      return shown(
        `${/export|write/.test(name) ? '生成' : /edit|changeset/.test(name) ? '修改' : /list/.test(name) ? '查找' : '阅读'}文件：${file}`,
      );
  }
  truncated = false;
  if (/fetch|browser/.test(name) && typeof args.url === 'string') {
    try {
      return `浏览 ${new URL(args.url).hostname} 网页`;
    } catch {
      /* No verified target. */
    }
  }
  if (
    name === 'skill' &&
    String(args.name ?? args.skill ?? args.skillName).toLowerCase() === 'office'
  )
    return '加载文档处理能力';
  if (/process.execute|bash|run_code/.test(name)) {
    const description = shortText(args.description, 120, clipped);
    if (
      description &&
      /[\u3400-\u9fff]/u.test(description) &&
      !/[\r\n`{};]/.test(description)
    )
      return shown(description);
  }
  return undefined;
}
