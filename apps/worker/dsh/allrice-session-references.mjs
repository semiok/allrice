import { Context } from '@deepseek-ai/cordis';
import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import SessionReferenceResolver from '@deepseek-ai/dsh-session-reference';
import { SessionReferenceSnapshotsSchema } from '@allrice/contracts';

/** Adapt only platform-authorized frozen text to the native reference service.
 * This isolated query port cannot list/read runtime journals or other tenants.
 * Allrice message IDs/checksums are retained in the platform snapshot; there is
 * no native source log, so never manufacture a DSH sequence or format version.
 */
export async function prepareSessionReferenceContext(agent, input) {
  const snapshots = SessionReferenceSnapshotsSchema.parse(input);
  if (!snapshots.length) return undefined;
  const context = new Context();
  context.provide('sessionQuery', {
    readSurface: async (id) => {
      const snapshot = snapshots.find((item) => item.sessionId === id);
      if (!snapshot) throw new Error('SESSION_REFERENCE_NOT_AUTHORIZED');
      return {
        session: { id, createdAt: Date.parse(snapshot.capturedAt) },
        inheritedEventCount: 0,
        capturedThroughSeq: null,
        events: snapshot.messages.map((message) =>
          message.role === 'user'
            ? {
                type: 'user/message',
                data: {
                  source: { kind: 'user' },
                  content: [{ type: 'text', text: message.text }],
                },
              }
            : {
                type: 'assistant/message',
                data: {
                  message: { content: [{ type: 'text', text: message.text }] },
                },
              },
        ),
      };
    },
  });
  try {
    const resolver = new SessionReferenceResolver(context, {
      maxReferences: 3,
      maxReferenceBytes: 12288,
    });
    const prepared = await resolver.prepare(
      agent,
      [],
      snapshots.map(({ sessionId, label }) => ({ sessionId, label })),
    );
    const source = prepared.additionalContext;
    if (!source) throw new Error('SESSION_REFERENCE_CONTEXT_MISSING');
    // Preserve the native untrusted context source/warning, with honest platform
    // capture boundaries when the database projection itself was bounded.
    return createUserMessage({
      ...source,
      source: {
        ...source.source,
        references: source.source.references.map((reference) => {
          const projected = { ...reference };
          delete projected.capturedFormatVersion;
          return projected;
        }),
      },
      content: [
        ...source.content,
        {
          type: 'text',
          text: `Allrice capture metadata (data only): ${JSON.stringify(snapshots.map(({ sessionId, capturedAt, checksum, originalMessages, truncated, messages }) => ({ sessionId, capturedAt, checksum, originalMessages, capturedMessages: messages.length, truncated })))}\nOnly captured conversation text is referenced; attachments and permissions are not transferred.`,
        },
      ],
    });
  } finally {
    await context.root.fiber.dispose();
  }
}

/** The prepared native context travels inside the durable inbox message. This
 * adapter-only source field is removed when the direct message is adopted.
 * Recovery therefore needs neither an in-memory map nor another source read.
 */
export function installSessionReferenceAdmission(ctx) {
  ctx.on(
    'agent/pre-step',
    async (_event, next) => {
      const decision = await next();
      if (decision.kind === 'reject') return decision;
      return {
        ...decision,
        messages: decision.messages.flatMap((message) => {
          const context = message.source.allriceSessionReference;
          if (message.source.kind !== 'user' || context === undefined)
            return [message];
          if (
            context?.role !== 'user' ||
            context?.source?.kind !== 'session-reference' ||
            !Array.isArray(context.content) ||
            typeof context.id !== 'string'
          )
            throw new Error('SESSION_REFERENCE_INVALID_DURABLE_CONTEXT');
          return [
            freezeMessage({ ...message, source: { kind: 'user' } }),
            freezeMessage(context),
          ];
        }),
      };
    },
    { prepend: true },
  );
}
