/** Public native tool-result forms, shared by receipt accounting and UI.
 * No text-based outcome inference: the authoritative isError must be true. */
export function readDshToolResult(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.role === 'tool') return message;
  if (!Array.isArray(message.content)) return null;
  return (
    message.content.find(
      (block): block is Record<string, unknown> =>
        !!block &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        block.type === 'tool-result',
    ) ?? null
  );
}
