import { createHash } from 'node:crypto';
import {
  BootstrapReceiptSchema,
  BootstrapCoverageQuerySchema,
} from '@allrice/contracts/native-runtime';

const messageDigest = (role, text) =>
  `sha256:${createHash('sha256').update(JSON.stringify({ role, text })).digest('hex')}`;

/** Public adopted events are the receipt, never inbox/IPC acknowledgement.
 * Native compaction retains this log and owns its semantic replacement. No
 * journal writes, history parser, private registry or second checkpoint store. */
export function readBootstrapCoverage(session, input) {
  const { scope, candidates } = BootstrapCoverageQuerySchema.parse(input);
  const wanted = new Set(
    candidates.map(({ key, digest }) => `${key}:${digest}`),
  );
  const covered = new Set();
  let assistantMessageId;
  const mark = (entry) => {
    if (entry && wanted.has(`${entry.key}:${entry.digest}`))
      covered.add(`${entry.key}:${entry.digest}`);
  };
  for (const event of session?.snapshotEvents() ?? []) {
    if (event.type === 'turn/start') assistantMessageId = undefined;
    if (event.type === 'user/message') {
      const source = event.data?.source;
      // A different direct/steered user input cannot inherit the previous
      // message's SQL assistant identity. Reference companions remain separate.
      if (source?.kind === 'user') assistantMessageId = undefined;
      const parsed = BootstrapReceiptSchema.safeParse(source?.allriceBootstrap);
      if (
        source?.kind !== 'user' ||
        !parsed.success ||
        parsed.data.scope !== scope
      )
        continue;
      for (const entry of parsed.data.imported) mark(entry);
      mark(parsed.data.userMessage);
      assistantMessageId = parsed.data.assistantMessageId;
    }
    if (
      event.type === 'assistant/message' &&
      assistantMessageId &&
      !event.data.interrupted
    ) {
      const blocks = event.data.message?.content;
      if (
        !Array.isArray(blocks) ||
        blocks.some((b) => !['text', 'reasoning'].includes(b.type))
      )
        continue;
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text)
        mark({
          key: `assistant:${assistantMessageId}`,
          digest: messageDigest('assistant', text),
        });
    }
    if (event.type === 'turn/end') assistantMessageId = undefined;
  }
  return {
    version: 1,
    sequence: session?.seq ?? 0,
    covered: candidates.filter(({ key, digest }) =>
      covered.has(`${key}:${digest}`),
    ),
  };
}
