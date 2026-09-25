import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { artifactDownloadLink } from './artifact-download-link';

type RootContent = ReturnType<typeof fromMarkdown>['children'][number];

/** Only the settled document needs SaaS URL adaptation. Streaming text goes
 * directly to DSH's incremental parser, without a second whole-text parse.
 */
export function markdownDeliveryText(
  text: string,
  artifacts: Parameters<typeof artifactDownloadLink>[1],
  allowRemoteImages: boolean,
  origin?: string,
) {
  if (allowRemoteImages && (!artifacts.length || !origin)) return text;
  const edits: { start: number; end: number; text: string }[] = [];
  const root = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const escape = (value: string) =>
    value.replace(/[&\\`*_$[\]<>]/g, (char) => `&#${char.charCodeAt(0)};`);
  const visit = (node: RootContent): void => {
    const start = node.position?.start.offset,
      end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (
      !allowRemoteImages &&
      (node.type === 'image' || node.type === 'imageReference')
    ) {
      edits.push({
        start,
        end,
        text: `&#91;图片：${escape(node.alt || '未加载外部图片')}&#93;`,
      });
      return;
    }
    if (origin && (node.type === 'link' || node.type === 'definition')) {
      const resolved = artifactDownloadLink(node.url, artifacts);
      if (
        resolved?.startsWith('/api/v1/files/') &&
        artifacts.some((a) =>
          resolved.startsWith(`/api/v1/files/${a.object.id}/download?`),
        )
      ) {
        const url = new URL(resolved, origin).href;
        const title = node.title ? ` ${JSON.stringify(node.title)}` : '';
        const label =
          node.type === 'link'
            ? text.slice(
                node.children[0]?.position?.start.offset ?? start + 1,
                node.children.at(-1)?.position?.end.offset ?? start + 1,
              )
            : '';
        const safeLabel = allowRemoteImages
          ? label
          : markdownDeliveryText(label, [], false);
        const replacement =
          node.type === 'definition'
            ? `[${node.label ?? node.identifier}]: <${url}>${title}`
            : `[${safeLabel}](<${url}>${title})`;
        edits.push({ start, end, text: replacement });
        return;
      }
    }
    if ('children' in node)
      for (const child of node.children) visit(child as RootContent);
  };
  root.children.forEach(visit);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
