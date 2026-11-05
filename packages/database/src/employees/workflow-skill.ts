import { fromMarkdown } from 'mdast-util-from-markdown';
import { workflowSkillInvalidMessage } from '@allrice/contracts';

/** Parse document structure, never user intent. Root headings inside fences,
 * blockquotes and lists are not framework sections. Return original Markdown
 * slices so author bytes are neither summarized nor reserialized. */
export function parseWorkflowSkillSections(body: string) {
  const nodes = fromMarkdown(body).children;
  const titles = ['工作步骤', '交付内容', '执行细节'];
  const sections = new Map<string, string>();
  let previous = -1;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.type !== 'heading' || node.depth !== 2) continue;
    const title = node.children.every((child) => child.type === 'text')
      ? node.children
          .map((child) => ('value' in child ? child.value : ''))
          .join('')
      : '';
    const position = titles.indexOf(title);
    if (position === -1) continue;
    if (position <= previous) throw new Error(workflowSkillInvalidMessage);
    previous = position;
    const end = nodes
      .slice(index + 1)
      .find((next) => next.type === 'heading' && next.depth <= 2);
    sections.set(
      title,
      body
        .slice(node.position!.end.offset!, end?.position?.start.offset)
        .trim(),
    );
  }
  if (sections.size !== titles.length)
    throw new Error(workflowSkillInvalidMessage);
  return {
    stepsMarkdown: sections.get('工作步骤')!,
    deliverablesMarkdown: sections.get('交付内容')!,
  };
}
