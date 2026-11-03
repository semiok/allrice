import { z } from 'zod';

export const ModelFailureCategorySchema = z.enum(['auth', 'quota', 'rate_limit', 'service', 'transport', 'context', 'unknown']);
export const ModelFailureSchema = z.object({ category: ModelFailureCategorySchema, upstreamMessage: z.string().max(1000) }).strict();
export type ModelFailureCategory = z.infer<typeof ModelFailureCategorySchema>;
const copies: Record<ModelFailureCategory, string> = {
  auth: '模型授权已失效。请联系管理员重新授权，反复重试无法恢复授权。',
  quota: '模型服务额度已用完。请联系管理员处理额度，反复重试无法解除限制。',
  rate_limit: '模型服务请求过于频繁。请稍后重试；持续出现请联系管理员。',
  service: '上游模型服务暂时不可用。请稍后重试；持续出现请联系管理员。',
  transport: '模型连接中断或等待超时。请稍后重试；持续出现请联系管理员。',
  context: '请求内容超过模型限制。请把任务拆小后再试。',
  unknown: '本次请求未完成。请联系管理员并提供错误编号。',
};
export function modelFailureText(category: ModelFailureCategory, reference?: string | null) {
  return copies[category] + (reference ? ` 错误编号：${reference}` : '');
}
/** Provider receipts only; a presentation category never changes a runtime code. */
export function isModelFailureCode(code: string | null | undefined) {
  return !!code && /^DSH_(?:PI_AI_ERROR|AUTH|INVALID_CREDENTIAL|QUOTA_EXCEEDED|ACCOUNT_QUOTA_EXCEEDED|RATE_LIMIT|SERVER|TRANSPORT|TIMEOUT|CONTEXT_WINDOW_EXCEEDED|INVALID_REQUEST|EMPTY_RESPONSE)$/.test(code);
}
export function modelFailure(message: unknown, status?: unknown): z.infer<typeof ModelFailureSchema> {
  let category: ModelFailureCategory = 'unknown';
  let upstreamMessage = '原文无法安全展示';
  try {
    if (typeof message !== 'string') return { category, upstreamMessage };
    // r1-exempt(own-text): 明确的上游错误回执，只分类展示，不解释用户指令或改变重试
    if (/\b(?:authentication|access|auth) token (?:has )?expired\b|\b(?:invalid|expired|revoked) (?:authentication|access) token\b|\binvalid (?:api key|credentials)\b/i.test(message) || status === 401 || status === 403) category = 'auth';
    else if (/\b(?:quota|credits?|balance) (?:is |has been )?(?:exhausted|depleted|exceeded)|\binsufficient (?:quota|credits?|balance)|\busage limit|\bquota exceeded/i.test(message)) category = 'quota';
    else if (status === 429 || /\brate.?limit|\btoo many requests\b/i.test(message)) category = 'rate_limit';
    else if ((typeof status === 'number' && status >= 500 && status <= 599) || /\boverloaded\b|\bservice unavailable\b|\binternal server error\b/i.test(message)) category = 'service';
    else if (/\b(?:network|connection|socket|fetch|timeout|ECONNRESET|ETIMEDOUT)\b|\btimed? out\b|\bWebSocket closed\b/i.test(message)) category = 'transport';
    else if (status === 413 || /\bcontext (?:window|length)|\bmaximum context|\b(?:payload|request body) too large\b/i.test(message)) category = 'context';
    upstreamMessage = message
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[已隐藏]')
      .replace(/\bBearer\s+[^\s"'<>]+|\b(?:sk-[\w-]+|AIza[\w-]+|gh[pousr]_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gi, '[已隐藏]')
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[已隐藏]')
      .replace(/\b(?:https?|wss?|ftp|file):\/\/[^\s<>"']+|\b(?:[\w-]+\.)+[A-Za-z]{2,}(?:\/[^\s<>"']*)?/gi, '[已隐藏]')
      .replace(/(?:[A-Za-z]:[\\/]|\\\\|~\/|\.\.?\/|\/)[^\s<>"']+/g, '[已隐藏]')
      .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b|\b[0-9A-HJKMNP-TV-Z]{26}\b|\b(?:req|resp|call|org|proj|user|acct|sess|chatcmpl|dsh)[_-][\w-]+/gi, '[已隐藏]')
      .replace(/((?:[\w-]*id|api[_-]?key|access[_-]?token|password|secret|cookie|authorization|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .slice(0, 1000);
  } catch { upstreamMessage = '原文无法安全展示'; }
  return { category, upstreamMessage };
}
/** Public DTO boundary: rebuild every modelFailure, including nested metadata.
 * Never give even a redacted provider message to the ordinary API. */
export function publicFailureData<T>(value: T, reference?: string | null): T {
  if (Array.isArray(value)) return value.map(v => publicFailureData(v, reference)) as T;
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const ref = typeof row.runId === 'string' ? row.runId : reference;
  return Object.fromEntries(Object.entries(row).map(([key, item]) => {
    if (key === 'modelFailure') {
      const parsed = ModelFailureCategorySchema.safeParse((item as { category?: unknown })?.category);
      return [key, { category: parsed.success ? parsed.data : 'unknown' }];
    }
    if ((key === 'errorMessage' || key === 'error_message') && typeof item === 'string')
      return [key, modelFailureText(modelFailure(item).category, ref)];
    if (key === 'error' && item && typeof item === 'object' && typeof (item as { message?: unknown }).message === 'string') {
      const error = item as { code: string; message: string };
      return [key, { code: error.code, message: modelFailureText(modelFailure(error.message).category, ref) }];
    }
    return [key, publicFailureData(item, ref)];
  })) as T;
}
