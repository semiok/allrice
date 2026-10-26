import type { Message } from './chatflow-types';

/** What the server returns for a sent message; read after the retry key is freed. */
export interface SendReceipt {
  run: { id: string };
  fallbackRunId?: string | null;
  delivery: 'immediate' | 'steer_pending' | 'follow_up';
  userMessage: Message;
  assistantMessage: Message;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isMessage(value: unknown, role: Message['role']) {
  if (!isRecord(value) || !isRecord(value.content)) return false;
  const { content } = value;
  return (
    typeof value.id === 'string' &&
    value.role === role &&
    ['pending', 'completed', 'failed'].includes(value.status as string) &&
    typeof value.createdAt === 'string' &&
    typeof content.text === 'string' &&
    (content.referenceSelections == null ||
      Array.isArray(content.referenceSelections)) &&
    (content.companyAssets == null || isRecord(content.companyAssets))
  );
}

/**
 * Every field the composer reads from the receipt. Only a receipt that passes
 * may free the retry key; otherwise a resend must reuse the same message ID.
 */
export function isSendReceipt(value: unknown): value is SendReceipt {
  return (
    isRecord(value) &&
    isRecord(value.run) &&
    typeof value.run.id === 'string' &&
    (value.fallbackRunId == null || typeof value.fallbackRunId === 'string') &&
    ['immediate', 'steer_pending', 'follow_up'].includes(
      value.delivery as string,
    ) &&
    isMessage(value.userMessage, 'user') &&
    isMessage(value.assistantMessage, 'assistant')
  );
}
