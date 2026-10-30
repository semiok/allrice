/** Wire framing only; callers retain their own event reducers and ownership. */
export function createSseDataConsumer() {
  const decoder = new TextDecoder();
  let buffer = '';
  return (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    return blocks
      .map((block) =>
        block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n'),
      )
      .filter(Boolean);
  };
}
