import { z } from 'zod';
import { modelGovernanceFailureText } from './governance.ts';

export const ModelFailureCategorySchema = z.enum([
  'auth',
  'quota',
  'rate_limit',
  'service',
  'transport',
  'context',
  'unknown',
]);
export type ModelFailureCategory = z.infer<typeof ModelFailureCategorySchema>;
export const ModelFailureSchema = z
  .object({
    category: ModelFailureCategorySchema,
    upstreamMessage: z.string().max(1000),
    code: z.string().min(1).max(160).optional(),
    status: z.number().int().min(100).max(599).optional(),
  })
  .strict();
export type ModelFailure = z.infer<typeof ModelFailureSchema>;
export const hiddenModelFailure = '原文无法安全展示';

const copies: Record<ModelFailureCategory, string> = {
  auth: '模型服务授权失效。请联系管理员重新授权，反复重试无法恢复授权。',
  quota: '模型服务额度已用完。请联系管理员处理额度，反复重试无法解除限制。',
  rate_limit: '模型服务请求过于频繁。请稍后重试；持续出现请联系管理员。',
  service: '上游模型服务暂时不可用。请稍后重试；持续出现请联系管理员。',
  transport: '模型连接中断或等待超时。请稍后重试；持续出现请联系管理员。',
  context: '请求内容超过模型限制。请把任务拆小后再试。',
  unknown: '模型服务返回了未归类的错误。请联系管理员并提供错误编号。',
};
export function modelFailureText(
  category: ModelFailureCategory,
  reference?: string | null,
) {
  return copies[category] + (reference ? ` 错误编号：${reference}` : '');
}

/** Historical provider codes only. UNKNOWN/TURN_FAILED are not model proof. */
export function isModelFailureCode(code: string | null | undefined) {
  return (
    !!code &&
    /^DSH_(?:PI_AI_ERROR|AUTH|INVALID_CREDENTIAL|QUOTA_EXCEEDED|ACCOUNT_QUOTA_EXCEEDED|RATE_LIMIT|SERVER|TRANSPORT|TIMEOUT|CONTEXT_WINDOW_EXCEEDED|INVALID_REQUEST|EMPTY_RESPONSE)$/.test(
      code,
    )
  );
}

/** Provider receipts only: display categories never change execution codes. */
export function classifyModelFailure(
  message: string,
  status?: unknown,
): ModelFailureCategory {
  if (
    status === 401 ||
    /\b(?:authentication|access|auth) token (?:has )?expired\b|\b(?:invalid|expired|revoked) (?:authentication|access) token\b|\binvalid (?:api key|credentials)\b|\bauthentication (?:failed|required)\b/i.test(
      message,
    )
  )
    return 'auth';
  // r1-exempt(external-text): 明确上游错误回执的展示分类，不解释用户指令，不改变执行和重试
  if (
    /\b(?:quota|credits?|balance) (?:is |has been )?(?:exhausted|depleted|exceeded)\b|\binsufficient[ _-](?:quota|credits?|balance)\b|\busage[_ -]limit[_ -](?:reached|exceeded)\b|\bhit (?:your |the )?(?:ChatGPT )?usage limit\b|\byou(?: have)? exceeded (?:your )?(?:current )?quota\b/i.test(
      message,
    )
  )
    return 'quota';
  if (
    status === 429 ||
    /\btoo many requests\b|\brate[ _-]?limit(?:ed|[ _-](?:exceeded|reached))\b/i.test(
      message,
    )
  )
    return 'rate_limit';
  if (
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    /\boverloaded\b|\bservice unavailable\b|\binternal server error\b/i.test(
      message,
    )
  )
    return 'service';
  if (
    /\b(?:connection|network|socket) (?:was )?(?:reset|closed|failed|lost|interrupted|unreachable)\b|\bfetch failed\b|\b(?:timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH)\b|\btimed? out\b|\bWebSocket closed\b|\bstream ended (?:before|without)\b/i.test(
      message,
    )
  )
    return 'transport';
  if (
    status === 413 ||
    /\b(?:maximum )?context (?:window|length) (?:has been )?(?:exceeded|exhausted)\b|\bexceeds? (?:the )?(?:maximum )?context (?:window|length)\b|\b(?:payload|request body) too large\b/i.test(
      message,
    )
  )
    return 'context';
  return 'unknown';
}

const sensitiveForms = [
  /\b(?:(?:request|response|trace|correlation|organization|project|account|user|session|conversation|job|run|turn|call|subscription|thread)[ _-]?)?id(?:\s*[:=]\s*|\s+)[^\r\n]*/gi,
  /(?:^|(?<=\s))\.[\w.-]+(?=\s|$)/gm,
  /%[A-Za-z_][A-Za-z0-9_]*%[\\/][^\r\n<>"']+/g,

  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
  /\bauthorization["']?\s*[:=][^\r\n]*/gi,
  /\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi,
  /\b(?:sk-[\w-]+|AIza[\w-]+|gh[pousr]_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
  /\b(?:https?|wss?|ftp|file):\/\/[^\s<>"']+|\b(?:[\w-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:\/[^\s<>"']*)?/gi,
  /(?:[A-Za-z]:[\\/]|\\\\|~\/|\.\.?\/|(?<![\w])\/)[^\r\n<>"']+/g,
  /\b[\w.-]+(?:[\\/][^\s"'<>]+)+/g,
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{16,}\b|\b[0-9A-HJKMNP-TV-Z]{26}\b|\b\d{8,}\b|\b(?:req|resp|call|org|proj|user|acct|sess|chatcmpl|dsh)[_-][\w-]+/gi,
  /\b(?:[\w-]*id|api[_-]?key|access[_-]?token|password|secret|cookie|token)["']?\s*[:=][^\r\n]*/gi,
];
const residualSensitive =
  /\bauthorization["']?\s*[:=]|\b(?:Bearer|Basic)\s+\S|\b(?:api[_-]?key|access[_-]?token|password|secret|cookie|token|[\w-]*id)["']?\s*[:=]|:\/\/|\bsk-|[\w.+-]+@[\w.-]+/i;

/** Unreliable input, redaction exceptions or residual credentials hide the
 * whole message. The original value is never a failure fallback. */
export function redactModelFailure(message: unknown): string {
  try {
    if (
      typeof message !== 'string' ||
      !message.trim() ||
      /[\p{Cc}\p{Cf}\p{Cs}]/u.test(
        message.replaceAll('\r', '').replaceAll('\n', '').replaceAll('\t', ''),
      )
    )
      return hiddenModelFailure;
    let safe = message;
    for (const pattern of sensitiveForms)
      safe = safe.replace(pattern, '[已隐藏]');
    if (residualSensitive.test(safe)) return hiddenModelFailure;
    for (const pattern of sensitiveForms) {
      pattern.lastIndex = 0;
      if (pattern.test(safe)) return hiddenModelFailure;
    }
    return safe.length > 1000 ? safe.slice(0, 999) + '…' : safe;
  } catch {
    return hiddenModelFailure;
  }
}

export function modelFailure(
  message: unknown,
  status?: unknown,
  code?: unknown,
): ModelFailure {
  const category =
    typeof message === 'string'
      ? classifyModelFailure(message, status)
      : 'unknown';
  return {
    category,
    upstreamMessage: redactModelFailure(message),
    ...(typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
      ? { status }
      : {}),
    ...(typeof code === 'string' && code.length > 0 && code.length <= 160
      ? { code }
      : {}),
  };
}

/** Stored JSONB is validated and redacted again at the admin boundary. */
export function readModelFailure(value: unknown): ModelFailure | null {
  try {
    const parsed = ModelFailureSchema.safeParse(value);
    return parsed.success
      ? {
          ...parsed.data,
          upstreamMessage: redactModelFailure(parsed.data.upstreamMessage),
        }
      : null;
  } catch {
    return null;
  }
}

/** A known error slot, never arbitrary business data. */
export function publicModelFailureMessage(
  code: string | null | undefined,
  message: string | null | undefined,
  reference?: string | null,
  proven?: Pick<ModelFailure, 'category'> | null,
) {
  const category =
    proven?.category ??
    (isModelFailureCode(code) ? modelFailure(message).category : null);
  if (category) return modelFailureText(category, reference);
  if (code?.startsWith('DSH_')) {
    const fixed =
      code === 'DSH_TURN_FAILED' ? null : modelGovernanceFailureText(code);
    return (
      (fixed ??
        '本次执行未完成，结果尚待确认。已有内容已保留，没有自动重做，请联系管理员。') +
      (reference ? ` 错误编号：${reference}` : '')
    );
  }
  return message ?? null;
}

/** Only the reserved private receipt is filtered at any nesting depth.
 * Business errorMessage/code/message fields are left intact. */
export function publicModelFailureMetadata(value: unknown): unknown {
  if (value === undefined) return value;
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (key !== 'modelFailure') return item;
      const category = ModelFailureCategorySchema.safeParse(
        item && typeof item === 'object'
          ? Reflect.get(item, 'category')
          : undefined,
      );
      return { category: category.success ? category.data : 'unknown' };
    }),
  ) as unknown;
}
