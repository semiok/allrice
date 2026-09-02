import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Admit AllRice wire images through DSH and project the ordered references into
 * the content-block shape expected by the upstream prompt implementation.
 */
export async function admitDshPromptImageBlocks(attachments, images) {
  const references = await admitEncodedImages(attachments, images);
  return references.map((attachment) => ({
    type: 'image',
    attachment,
  }));
}

/**
 * Translate one AllRice steer string into the immutable upstream user message
 * and submit it to the live DSH agent.
 */
export function steerDshAgent(agent, text) {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  agent.steer(message);
  return message.id;
}
