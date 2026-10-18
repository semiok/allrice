import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { NativeSessionDescriptor } from '@allrice/database';
import { HandlerError } from '../errors.js';
import type * as NativeCordis from '@deepseek-ai/cordis';
import type * as NativePersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import type * as NativeSession from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';

/** Metadata-only read through the approved reader's public backend. No model,
 * AgentLoop, writer, path-layout copy or new storage materialization. */
export async function assertStoredNativeSession(
  entrypoint: string,
  descriptor: NativeSessionDescriptor,
  signal: AbortSignal,
) {
  const require = createRequire(entrypoint);
  const { Context } = (await import(
    pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
  )) as typeof NativeCordis;
  const backend = (await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
      .href
  )) as typeof NativePersistence & { default?: typeof NativePersistence };
  const { SessionId } = (await import(
    pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href
  )) as typeof NativeSession;
  const ctx = new Context();
  const reader = ctx.plugin(backend.default ?? backend, {
    root: descriptor.storageNamespace,
    compression: 'none',
  });
  try {
    await reader.await();
    const persistence = ctx.get('sessionPersistence') as SessionPersistence;
    const stored = await persistence.stat(
      SessionId(descriptor.nativeSessionId),
      { signal },
    );
    if (!stored || stored.header.id !== descriptor.nativeSessionId)
      throw Error('identity_missing');
  } catch {
    throw new HandlerError(
      'DSH_NATIVE_SESSION_STORAGE_UNAVAILABLE',
      '原会话资料暂不可用，已保留绑定与执行记录。',
      false,
    );
  } finally {
    await reader.dispose();
  }
}
