import { z } from 'zod';

const eventSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
/** Only exact persisted inbox/message IDs count. Text mentioning an ID is not
 * a receipt; missing ACK identities cannot be reconstructed by guessing. */
export function assistantNativeCheckpointEvidence(
  inspection: Record<string, unknown>,
  messages: readonly {
    inputId: string;
    nativeMessageId: string | null;
    durableSeq: number | null;
    adoptedSeq: number | null;
  }[],
) {
  const events = z.array(eventSchema).max(100000).parse(inspection.events);
  return messages.flatMap((message) => {
    if (!message.nativeMessageId) return [];
    const adopted = events.find(
      (event) =>
        event.type === 'user/message' &&
        event.data.id === message.nativeMessageId,
    );
    const queued = events.find(
      (event) =>
        event.type === 'agent/inbox/spliced' &&
        Array.isArray(event.data.inserted) &&
        event.data.inserted.some(
          (item) =>
            item &&
            typeof item === 'object' &&
            'id' in item &&
            item.id === message.nativeMessageId,
        ),
    );
    const durableSeq = message.durableSeq ?? (adopted ?? queued)?.seq;
    if (durableSeq === undefined) return [];
    const adoptedSeq = message.adoptedSeq ?? adopted?.seq;
    return [
      {
        inputId: message.inputId,
        nativeMessageId: message.nativeMessageId,
        durableSeq,
        ...(adoptedSeq === undefined ? {} : { adoptedSeq }),
      },
    ];
  });
}
