const explicitRememberPattern =
  /(?:请|帮我|以后|今后|之后|你)?(?:记住|记下|记得|保存(?:为|成)?(?:长期)?记忆)|(?:以后|今后)(?:按此|照此|按这个|照这个|按照这个)|\bremember\b|\bkeep (?:this|that) in mind\b/i;
const explicitForgetPattern =
  /(?:不要|不用|别)(?:记住|记下|保存)|\b(?:do not|don't) remember\b|\bforget (?:this|that)\b/i;

/**
 * Durable memory is a user-controlled action. A model or untrusted tool result
 * cannot opt itself into long-term memory merely by calling the write tool.
 */
export function hasExplicitRememberIntent(userRequest: string | undefined) {
  const request = userRequest?.trim() ?? '';
  return (
    request.length > 0 &&
    explicitRememberPattern.test(request) &&
    !explicitForgetPattern.test(request)
  );
}

export interface MemoryCandidateMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
}

const candidateSignalPattern =
  /记住|记下|我的?偏好|我喜欢|我习惯|以后(?:请|要|都)|(?:我|我们)(?:已经)?决定|项目(?:要求|目标|约束|背景)|必须|不要|remember|I prefer|my preference|we decided|project (?:goal|constraint|requirement|context)|must|always|never/i;

export function hasStableMemorySignal(userRequest: string | undefined) {
  const request = userRequest?.trim() ?? '';
  return (
    request.length > 0 &&
    candidateSignalPattern.test(request) &&
    !explicitForgetPattern.test(request)
  );
}

/**
 * Create a reviewable pre-compaction candidate from user-authored statements
 * only. Assistant output, tool results and external page content are excluded
 * so untrusted data can never be promoted by the checkpoint path.
 */
export function buildCheckpointMemoryCandidate(
  messages: readonly MemoryCandidateMessage[],
  maximumCharacters = 4_000,
) {
  const selected = messages.filter(
    (message) => message.role === 'user' && hasStableMemorySignal(message.text),
  );
  if (selected.length === 0) return null;
  const content = [
    '预压缩候选记忆（仅包含用户原话，需确认后才作为长期记忆使用）：',
    ...selected.map((message) => `[message:${message.id}] ${message.text}`),
  ].join('\n');
  if (content.length <= maximumCharacters) return content;
  return `${content.slice(0, Math.max(0, maximumCharacters - 24))}\n[候选记忆已安全截断]`;
}
