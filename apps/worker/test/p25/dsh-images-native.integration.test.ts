/** Real rc.3 attachment storage and stdio runtime; only the model is synthetic. */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore, {
  type Config,
} from '@deepseek-ai/dsh-attachment-local';
import type { AttachmentAdmissionPart } from '@deepseek-ai/dsh-attachment';
import { describe, expect, it } from 'vitest';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { p24Fixture } from '../p24/fixture.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC';
const largerPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWNgYPgPRmAKABf2A/38FIMyAAAAAElFTkSuQmCC';
const image = { type: 'image', mediaType: 'image/png', data: png } as const;

describe('MET154 native prompt image admission', () => {
  const refusals: {
    code: string;
    config: Config;
    parts: AttachmentAdmissionPart[];
  }[] = [
    {
      code: 'INVALID_IMAGE_BASE64',
      config: {},
      parts: [{ ...image, data: 'not-base64' }],
    },
    { code: 'INVALID_IMAGE', config: {}, parts: [{ ...image, data: 'AQI=' }] },
    {
      code: 'IMAGE_TYPE_MISMATCH',
      config: {},
      parts: [image, { ...image, mediaType: 'image/jpeg' }],
    },
    {
      code: 'TOO_MANY_IMAGES',
      config: { maxImagesPerMessage: 1 },
      parts: [image, image],
    },
    { code: 'IMAGE_TOO_LARGE', config: { maxImageBytes: 1 }, parts: [image] },
    {
      code: 'IMAGES_TOO_LARGE',
      config: { maxMessageImageBytes: 1 },
      parts: [image],
    },
    {
      code: 'IMAGE_TOO_MANY_PIXELS',
      config: { maxImagePixels: 1 },
      parts: [{ ...image, data: largerPng }],
    },
    {
      code: 'IMAGE_DIMENSION_TOO_LARGE',
      config: { maxImageDimension: 1 },
      parts: [{ ...image, data: largerPng }],
    },
  ];
  it.each(refusals)(
    'refuses $code before publishing any object',
    async ({ code, config, parts }) => {
      const root = await mkdtemp(join(tmpdir(), 'allrice-image-admission-'));
      const ctx = new Context();
      try {
        const store = new LocalAttachmentStore(ctx, {
          dshHome: root,
          ...config,
        });
        await expect(store.admitPromptContent(parts)).rejects.toMatchObject({
          code,
        });
        expect(await readdir(root, { recursive: true })).toEqual([]);
      } finally {
        await ctx.root.fiber.dispose();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps names, order and one durable message across native dispatch and restart', async () => {
    const model = await p24Fixture(async () => ({ text: 'Images received.' }));
    const clients: DshProtocolClient[] = [];
    const profile = join(model.root, 'images.cordis.yml');
    const launch = async () => {
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: model.root,
        requestTimeoutMs: 15_000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_CORDIS_CONFIG: profile,
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(model.root, 'sessions'),
          DSH_HOME: model.root,
          DSH_CWD: model.root,
          DSH_CREDENTIALS_PATH: join(model.root, 'credentials.yaml'),
          DSH_MODEL: 'native-images',
          DSH_CODEX_MODEL: 'gpt-5.6-luna',
          DSH_OPENAI_COMPATIBLE_MODEL: 'native-images',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: model.baseUrl,
        },
      });
      clients.push(client);
      await client.initialize({
        cwd: model.root,
        provider: 'openai-compatible',
        model: 'native-images',
        nativeTools: [],
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      });
      return client;
    };
    try {
      // The synthetic model is outside the catalog; declare vision only in
      // its temporary profile. Unknown production routes remain text-only.
      // Cordis resolves plugins relative to this temporary profile.
      await symlink(
        resolve(import.meta.dirname, '../../node_modules'),
        join(model.root, 'node_modules'),
        'dir',
      );
      const config = await readFile(
        resolve(import.meta.dirname, '../../dsh/allrice-restricted.cordis.yml'),
        'utf8',
      );
      await writeFile(
        profile,
        config.replace(
          '        api: openai-completions\n',
          '        api: openai-completions\n        defaultInput: [text, image]\n',
        ),
      );
      const client = await launch();
      const notices: DshNotification[] = [];
      client.subscribe((notice) => notices.push(notice));
      const sessionId = `native-images-${randomUUID()}`;
      // A valid first member must not make a rejected second member partial work.
      await expect(
        client.prompt(sessionId, 'Rejected batch', [
          image,
          { ...image, mediaType: 'image/jpeg' },
        ]),
      ).rejects.toMatchObject({ code: 'DSH_REQUEST_FAILED' });
      expect(model.requests).toHaveLength(0);
      expect(notices.filter((n) => n.method === 'session.event')).toEqual([]);
      const messageId = await client.prompt(
        sessionId,
        'Compare these two images.',
        [
          { ...image, name: '/private/uploads/one.png' },
          { ...image, data: largerPng, name: 'C:\\uploads\\two.png' },
        ],
      );
      await expect
        .poll(
          () =>
            notices.some(
              (n) =>
                n.method === 'session.event' &&
                (n.params.event as { type?: string }).type === 'turn/end',
            ),
          { timeout: 15_000 },
        )
        .toBe(true);
      const userEvents = notices
        .filter((n) => n.method === 'session.event')
        .map((n) => n.params.event as { type: string; data: unknown })
        .filter((event) => event.type === 'user/message');
      expect(userEvents).toHaveLength(1);
      const content = [
        { type: 'text', text: 'Compare these two images.' },
        ...[png, largerPng].map((data, index) => ({
          type: 'image',
          attachment: {
            attachmentId: `sha256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex')}`,
            mediaType: 'image/png',
            bytes: Buffer.from(data, 'base64').length,
            width: index + 1,
            height: index + 1,
            name: index === 0 ? 'one.png' : 'two.png',
          },
        })),
      ];
      expect(userEvents[0]?.data).toMatchObject({ id: messageId, content });
      expect(model.requests).toHaveLength(1);
      const input = JSON.stringify(model.requests[0]?.messages);
      expect(input).toContain('one.png');
      expect(input).toContain('two.png');
      expect(input).toContain(png);
      expect(input).toContain(largerPng);
      expect(input.indexOf(png)).toBeLessThan(input.indexOf(largerPng));
      expect(input).not.toContain('/private/uploads');
      expect(input).not.toContain('C:\\uploads');
      await client.close();
      const history = (await model.logs())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; data: unknown })
        .filter((event) => event.type === 'user/message');
      expect(history).toHaveLength(1);
      expect(history[0]?.data).toMatchObject({ id: messageId, content });
      const recovered = await launch();
      await expect(recovered.recover(sessionId)).resolves.toMatchObject({
        recovered: true,
      });
      await recovered.prompt(sessionId, 'Describe the same images again.');
      await expect
        .poll(() => model.requests.length, { timeout: 15_000 })
        .toBe(2);
      expect(JSON.stringify(model.requests[1]?.messages)).toContain(png);
      expect(JSON.stringify(model.requests[1]?.messages)).toContain(largerPng);
      expect(JSON.stringify(model.requests[1]?.messages)).toContain(
        'Describe the same images again.',
      );
      await recovered.close();
      expect(model.requests).toHaveLength(2);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await model.close();
    }
  }, 45_000);
});
