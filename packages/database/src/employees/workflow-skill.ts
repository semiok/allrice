import { fromMarkdown } from 'mdast-util-from-markdown';
import { workflowSkillInvalidMessage } from '@allrice/contracts';
import { z } from 'zod';

// This is the structure of an author-supplied technical document. It does not
// infer conversational intent, approval or permission from the document text.
const sectionTitle = z.enum(['工作步骤', '交付内容', '执行细节']);
const sectionOrder = z.tuple([
  z.literal('工作步骤'),
  z.literal('交付内容'),
  z.literal('执行细节'),
]);

/** Parse document structure, never user intent. Root headings inside fences,
 * blockquotes and lists are not framework sections. Return original Markdown
 * slices so author bytes are neither summarized nor reserialized. */
export function parseWorkflowSkillSections(body: string) {
  const nodes = fromMarkdown(body).children;
  const sections: { title: z.infer<typeof sectionTitle>; content: string }[] =
    [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.type !== 'heading' || node.depth !== 2) continue;
    const title = node.children.every((child) => child.type === 'text')
      ? node.children
          .map((child) => ('value' in child ? child.value : ''))
          .join('')
      : '';
    const parsed = sectionTitle.safeParse(title);
    if (!parsed.success) continue;
    const end = nodes
      .slice(index + 1)
      .find((next) => next.type === 'heading' && next.depth <= 2);
    sections.push({
      title: parsed.data,
      // Strip only boundary blank lines. trim() would remove indentation from
      // an initial code block and change what the author's Markdown means.
      content: body
        .slice(node.position!.end.offset!, end?.position?.start.offset)
        .replace(/^(?:[ \t]*\r?\n)+/, '')
        .replace(/(?:\r?\n[ \t]*)+$/, ''),
    });
  }
  if (!sectionOrder.safeParse(sections.map((section) => section.title)).success)
    throw new Error(workflowSkillInvalidMessage);
  return {
    stepsMarkdown: sections[0]!.content,
    deliverablesMarkdown: sections[1]!.content,
  };
}
