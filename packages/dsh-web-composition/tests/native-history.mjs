import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';

export const processSession = 'session-00000000-0000-4000-8000-000000000036';
export const documentSession = 'session-00000000-0000-4000-8000-000000000038';
export const deliveryName = '核对说明-长文件名用于验证原生交付文档预览.md';

/** Import only public package exports from the caller's installed native Host. */
export async function importFromHost(hostRequire, name) {
  return import(pathToFileURL(hostRequire.resolve(name)).href);
}

/** Replay static history through native persistence; no event execution layer. */
export async function prepareNativeHistory(hostRequire, root) {
  const { Context } = await importFromHost(hostRequire, '@deepseek-ai/cordis');
  const persistence = await importFromHost(
    hostRequire,
    '@deepseek-ai/dsh-session-persistence-jsonl',
  );
  const ctx = new Context();
  const workspace = join(root, 'workspace');
  const sessions = join(root, 'sessions');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, deliveryName),
    '# 原生文档保留验证\n\n三条销售记录合计 **56.30 元**。\n',
  );
  const counts = {};
  try {
    await ctx.plugin(persistence, { root: sessions, compression: 'none' });
    for (const name of ['process', 'subagent', 'question-document']) {
      const raw = await readFile(
        new URL(`./fixtures/${name}.json`, import.meta.url),
        'utf8',
      );
      const [physical, ...events] = JSON.parse(
        raw.replaceAll('__WORKSPACE__', JSON.stringify(workspace).slice(1, -1)),
      );
      const header = { ...physical };
      delete header.type;
      // The public backend owns filename/layout/codec selection and validates rows.
      const writer = await ctx.sessionPersistence.create(header);
      try {
        await writer.append(events);
        await writer.flush();
      } finally {
        await writer.close();
      }
      const reader = await ctx.sessionPersistence.open(header.id, 'read');
      try {
        counts[header.id] = (await reader.read()).events.length;
      } finally {
        await reader.close();
      }
    }
  } finally {
    await ctx.fiber.dispose();
  }
  return { workspace, sessions, counts };
}
