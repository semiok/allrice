import { randomUUID } from 'node:crypto';
import {
  DataAccessError,
  IdentityError,
  isPlatformAdmin,
  recordGeminiCredentialChange,
} from '@allrice/database';

import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import {
  portalAuthEnabled,
  resolvePortal,
} from '../../../../../../../lib/portal/config';
import {
  GeminiCredentialError,
  getGeminiCredentialStatus,
  saveGeminiCredential,
  validateGeminiApiKey,
} from '../../../../../../../lib/providers/gemini-credential-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

function problem(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status, headers });
}

async function authorize(request: Request) {
  const context = await requirePlatformAdminContext(request);
  if (
    (portalAuthEnabled() &&
      resolvePortal(request.headers.get('host'))?.kind !== 'platform_admin') ||
    !(await isPlatformAdmin(context))
  )
    throw new DataAccessError('authorization_denied');
  return context;
}

function errorResponse(error: unknown) {
  if (error instanceof DataAccessError || error instanceof IdentityError)
    return problem(
      error.code === 'authentication_required' ||
        error.code === 'authentication_failed'
        ? 401
        : 403,
      'ACCESS_DENIED',
      '仅平台管理员可管理此密钥，请确认登录状态。',
    );
  if (error instanceof SyntaxError)
    return problem(400, 'INVALID_INPUT', '请输入有效的 API Key。');
  if (error instanceof GeminiCredentialError) {
    if (error.code === 'invalid_key')
      return problem(
        400,
        'INVALID_KEY',
        '密钥格式不正确，请只粘贴 API Key，不要包含命令或换行。',
      );
    if (error.code === 'busy')
      return problem(
        409,
        'SAVE_CONFLICT',
        '另一个保存正在进行，请稍后刷新重试。',
      );
    return problem(
      503,
      'STORE_UNAVAILABLE',
      '服务端凭证存储尚未就绪，无法读取或保存。请联系平台管理员。',
    );
  }
  // Never log raw exceptions: JSON, filesystem and database errors can contain inputs.
  return problem(500, 'SAVE_FAILED', '暂时无法处理密钥配置，请刷新后重试。');
}

async function readKey(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new SyntaxError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !('apiKey' in body)
  )
    throw new SyntaxError();
  return validateGeminiApiKey(body.apiKey);
}

export async function GET(request: Request) {
  try {
    await authorize(request);
    return Response.json(
      { credential: await getGeminiCredentialStatus() },
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await authorize(request);
    // No proxy-provided origin whitelist. Compare the browser origin to the actual Host.
    const origin = request.headers.get('origin');
    const host = request.headers.get('host') ?? new URL(request.url).host;
    if (!origin || origin === 'null')
      return problem(403, 'ORIGIN_REQUIRED', '请从当前后台页面保存密钥。');
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return problem(403, 'ORIGIN_DENIED', '请求来源不匹配。');
    }
    if (
      parsed.origin !== origin ||
      parsed.host !== host ||
      !['https:', 'http:'].includes(parsed.protocol) ||
      (parsed.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) ||
      request.headers.get('sec-fetch-site') === 'cross-site'
    )
      return problem(403, 'ORIGIN_DENIED', '请求来源不匹配。');
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json'
    )
      return problem(415, 'JSON_REQUIRED', '请求必须使用 JSON。');
    const apiKey = await readKey(request);
    const requestId = randomUUID();
    // Durable intent must succeed BEFORE any credential changes; audit never receives the key.
    await recordGeminiCredentialChange(context, requestId, 'requested');
    let credential;
    try {
      credential = await saveGeminiCredential(apiKey, context.actor.id);
    } catch (error) {
      await recordGeminiCredentialChange(context, requestId, 'failed').catch(
        () => {},
      );
      throw error;
    }
    let auditRecorded = true;
    await recordGeminiCredentialChange(context, requestId, 'saved').catch(
      () => {
        auditRecorded = false;
      },
    );
    return Response.json({ credential, auditRecorded }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
