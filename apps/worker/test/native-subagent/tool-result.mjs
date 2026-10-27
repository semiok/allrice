/** Read only the result block for this call, never the prompt or call name. */
export function toolResult(messages, callId) {
  return messages
    .flatMap((message) =>
      message.role === 'tool'
        ? [{ ...message, type: 'tool-result' }]
        : (message.content ?? []),
    )
    .find(
      (block) => block.type === 'tool-result' && block.toolCallId === callId,
    );
}
