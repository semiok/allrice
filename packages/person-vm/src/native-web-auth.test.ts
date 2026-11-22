import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  nativeWebAuthArtifact,
  NATIVE_WEB_AUTH_READER,
  parseNativeWebAuth,
} from './native-web-auth.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const dshHome = await mkdtemp('/tmp/ar-web-auth-');
  roots.push(dshHome);
  const request = {
    dshHome,
    nonce: randomUUID(),
    origin: 'http://127.0.0.1:32179/',
    timeoutMs: 3000,
  };
  const artifact = nativeWebAuthArtifact(request);
  await mkdir(join(dshHome, 'native-web'));
  const value = {
    v: 1,
    nonce: request.nonce,
    authenticatedUrl: `${request.origin}?token=${'a'.repeat(43)}`,
  };
  return { request, artifact, value };
}
function reader(file: string, size: number) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      NATIVE_WEB_AUTH_READER + '\nprocess.send("watching");',
      file,
      String(size),
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let out = '',
    err = '';
  child.stdout!.on('data', (data) => {
    out += String(data);
  });
  child.stderr!.on('data', (data) => {
    err += String(data);
  });
  const watching = new Promise<void>((resolve) =>
    child.once('message', () => resolve()),
  );
  const done = new Promise<{ code: number | null; out: string; err: string }>(
    (resolve) => child.once('close', (code) => resolve({ code, out, err })),
  );
  return { child, watching, done };
}
it('实际reader在原子发布前已监听，不丢唤醒；只回已知nonce和目标的native auth', async () => {
  const f = await fixture(),
    r = reader(f.artifact.path, f.artifact.maxBytes);
  try {
    await r.watching;
    await writeFile(f.artifact.path + '.tmp', JSON.stringify(f.value), {
      mode: 0o600,
    });
    await rename(f.artifact.path + '.tmp', f.artifact.path);
    const result = await r.done;
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(parseNativeWebAuth(result.out, f.request)).toEqual({
      authenticatedUrl: f.value.authenticatedUrl,
    });
  } finally {
    if (r.child.exitCode === null) r.child.kill('SIGKILL');
    await r.done;
  }
});
it('实际reader拒绝symlink/超长，不输出其内容；解析错不携带资格', async () => {
  const f = await fixture(),
    elsewhere = join(f.request.dshHome, 'elsewhere');
  await writeFile(elsewhere, JSON.stringify(f.value));
  await symlink(elsewhere, f.artifact.path);
  let r = reader(f.artifact.path, f.artifact.maxBytes);
  expect(await r.done).toMatchObject({ code: 1, out: '' });
  await rm(f.artifact.path);
  await writeFile(f.artifact.path, 'secret'.repeat(f.artifact.maxBytes));
  r = reader(f.artifact.path, f.artifact.maxBytes);
  expect(await r.done).toMatchObject({ code: 1, out: '' });
  for (const value of [
    { ...f.value, nonce: randomUUID() },
    {
      ...f.value,
      authenticatedUrl: `http://127.0.0.1:32180/?token=${'a'.repeat(43)}`,
    },
    { ...f.value, actorId: 'guest claim' },
    { ...f.value, authenticatedUrl: 'invalid-secret' },
  ]) {
    let failure: unknown;
    try {
      parseNativeWebAuth(JSON.stringify(value), f.request);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(String(failure)).not.toContain('invalid-secret');
  }
});
