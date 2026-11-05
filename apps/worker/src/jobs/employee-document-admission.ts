import type { ExecutionContext } from '@allrice/contracts';
import { readEmployeeChatSourceKind } from '@allrice/database';
import { HandlerError } from '../errors.js';

/** Preserve internal/scheduled Runs, but never infer that a denied human gate
 * makes a historical ordinary Run an internal producer. No history rewrite or
 * retroactive ledger issuance: an old ordinary Run must start a new task. */
export async function admitEmployeeDocuments(input: {
  context: ExecutionContext;
  userMessageId: string;
  documents: boolean;
}) {
  const kind = await readEmployeeChatSourceKind(input);
  if (input.documents ? kind === 'human' : kind === 'internal') return kind;
  throw new HandlerError(
    'MEMORY_CONTEXT_UNAVAILABLE',
    input.documents
      ? '无法核对本次记忆的真人来源，请重新发起任务。'
      : '此任务缺少当前记忆快照，不能安全恢复。历史记录已保留，请重新发起任务。',
    false,
  );
}
