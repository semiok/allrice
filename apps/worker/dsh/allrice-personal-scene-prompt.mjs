import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { BootstrapReceiptSchema } from '@allrice/contracts/native-runtime';

/** This is a private Worker envelope, not a slash parser. Enqueue the complete
 * input with the public Agent API before waking it once. Native tool-skill sees
 * only the current verified human text as source=user. */
export function enqueuePersonalScenePrompt(agent, params, blocks, reference) {
  const parts = params.personalScenePrompt;
  if (
    !Array.isArray(parts) ||
    parts.length > 3 ||
    parts.some(
      (p) =>
        !p ||
        !['user', 'allrice-context'].includes(p.kind) ||
        typeof p.text !== 'string',
    ) ||
    parts.filter((p) => p.kind === 'user').length > 1 ||
    blocks[0]?.type !== 'text' ||
    blocks.slice(1).some((b) => b.type !== 'image') ||
    parts.map((p) => p.text).join('\n\n') !== blocks[0].text
  )
    throw Error('employee_scene_prompt_source_invalid');
  const messages = parts.map((p) =>
    createUserMessage({
      source: { kind: p.kind },
      content: [{ type: 'text', text: p.text }],
    }),
  );
  // Image-only input and empty human text still retain their admitted images.
  if (!messages.length)
    messages.push(
      createUserMessage({ source: { kind: 'allrice-context' }, content: [] }),
    );
  const human = messages.find((m) => m.source.kind === 'user');
  const last = messages.at(-1);
  const imageTarget = human ?? last;
  const imageIndex = messages.indexOf(imageTarget);
  messages[imageIndex] = freezeMessage({
    ...imageTarget,
    content: [...imageTarget.content, ...blocks.slice(1)],
  });
  if (reference) messages.push(reference);
  const tail = messages.at(-1);
  if (params.bootstrapReceipt) {
    // Put coverage after all companions, so adopting a later human input
    // cannot reset the assistant receipt for this same atomic prompt.
    messages[messages.length - 1] = freezeMessage({
      ...tail,
      source: {
        ...tail.source,
        allriceBootstrap: BootstrapReceiptSchema.parse(params.bootstrapReceipt),
      },
    });
  }
  for (const message of messages.slice(0, -1))
    agent.send(message, 'next-turn', false);
  agent.followup(messages.at(-1));
  return { messageId: (human ?? messages.at(-1)).id };
}
