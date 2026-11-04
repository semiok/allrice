import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { BootstrapReceiptSchema } from '@allrice/contracts/native-runtime';

/** One durable inbox entry, with context companions expanded by public
 * pre-step middleware after native slash parsing has seen the human text. */
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
  const index = human ? messages.findIndex((m) => m.id === human.id) : 0;
  const direct = messages[index];
  agent.followup(
    freezeMessage({
      ...direct,
      source: {
        ...direct.source,
        allricePersonalPrompt: {
          before: messages.slice(0, index),
          after: messages.slice(index + 1),
        },
      },
    }),
  );
  return { messageId: direct.id };
}

/** Like native session-reference admission, this expands a durable companion
 * without editing the original pre-step input that tool-skill parses. Native
 * injections stay real native messages; no synthetic tool result is created. */
export function installPersonalScenePromptAdmission(ctx) {
  ctx.on(
    'agent/pre-step',
    async (_event, next) => {
      const decision = await next();
      if (decision.kind === 'reject') return decision;
      return {
        ...decision,
        messages: decision.messages.flatMap((message) => {
          const { allricePersonalPrompt: companions, ...source } =
            message.source;
          if (companions === undefined) return [message];
          if (
            !['user', 'allrice-context'].includes(source.kind) ||
            !Array.isArray(companions?.before) ||
            !Array.isArray(companions?.after) ||
            companions.before.length + companions.after.length > 3 ||
            [...companions.before, ...companions.after].some(
              (m) =>
                m?.role !== 'user' ||
                !['allrice-context', 'session-reference'].includes(
                  m.source?.kind,
                ) ||
                typeof m.id !== 'string' ||
                !Array.isArray(m.content),
            )
          )
            throw Error('employee_scene_prompt_source_invalid');
          return [
            ...companions.before.map(freezeMessage),
            freezeMessage({ ...message, source }),
            ...companions.after.map(freezeMessage),
          ];
        }),
      };
    },
    { prepend: true },
  );
}
