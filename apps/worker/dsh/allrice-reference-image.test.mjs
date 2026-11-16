import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {
  referenceImageOperation,
  referenceImageOutput,
} from './allrice-reference-image.mjs';

const data =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC';
const params = () => ({
  runId: 'run-1',
  call: {
    id: 'call-1',
    name: 'workspace.reference.read_image',
    nativeSessionId: 'native-1',
  },
  deadlineAt: Date.now() + 29000,
  data,
  mediaType: 'image/png',
  name: 'diagram.png',
});
function server(store, info, routed) {
  const agent = {
    id: 'native-1',
    options: { provider: 'default', model: 'default' },
    session: { requestHeader: () => (routed ? { config: routed } : undefined) },
  };
  const resolutions = [];
  return {
    resolutions,
    ctx: {
      agents: { get: (id) => (id === agent.id ? agent : undefined) },
      get: (name) =>
        name === 'attachments'
          ? store
          : {
              resolveModelInfo: async (...args) => {
                resolutions.push(args);
                return info;
              },
            },
    },
    runAdmission: {
      attribute: () => ({ runId: 'run-1' }),
      rootFor: (value) => {
        assert.equal(value, agent);
        return agent;
      },
    },
  };
}
for (const info of [{}, { inputModalities: ['text'] }])
  test('unknown/text route refuses with readable explanation before attachment writes', async () => {
    let writes = 0;
    const s = server(
      {
        saveImages: () => {
          writes++;
          throw Error('must not save');
        },
      },
      info,
    );
    const result = await referenceImageOperation(s, 'save', params());
    assert.equal(result.error.code, 'REFERENCE_READ_UNSUPPORTED');
    assert.equal(result.error.reason, 'image_route');
    assert.ok(result.error.message.length > 20);
    assert.equal(writes, 0);
  });
test('current request header, not stale agent defaults, chooses the explicit image route', async () => {
  const s = server(
    {},
    { inputModalities: ['text', 'image'] },
    { provider: 'routed', model: 'routed-model' },
  );
  assert.deepEqual(await referenceImageOperation(s, 'route', params()), {
    supported: true,
  });
  assert.deepEqual(s.resolutions[0].slice(0, 2), ['routed', 'routed-model']);
  await assert.rejects(
    referenceImageOperation(s, 'route', { ...params(), runId: 'other' }),
    /RUN_SESSION_DENIED/,
  );
});
test('route resolver faults retain their error rather than claiming unsupported image input', async () => {
  const fault = Object.assign(Error('resolver failed'), {
    code: 'INVALID_MODEL_INFO',
  });
  const s = server({}, {});
  s.ctx.get = () => ({
    resolveModelInfo: async () => {
      throw fault;
    },
  });
  await assert.rejects(
    referenceImageOperation(s, 'route', params()),
    (error) => error === fault,
  );
});
test('native save remains joined past the deadline before returning the business timeout', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const s = server(
    {
      saveImages: async () => {
        entered();
        await held;
        return [{}];
      },
    },
    { inputModalities: ['image'] },
  );
  let settled = false;
  const result = referenceImageOperation(s, 'save', {
    ...params(),
    deadlineAt: Date.now() + 50,
  }).finally(() => {
    settled = true;
  });
  await started;
  await delay(75);
  assert.equal(settled, false);
  release();
  assert.equal((await result).error.code, 'REFERENCE_READ_TIMEOUT');
});
test.each(['png', 'jpeg'])(
  'native %s persistence and render retain a real attachment across store recreation',
  async (format) => {
    const home = await mkdtemp(join(tmpdir(), 'reference-image-'));
    const ctx = new Context();
    try {
      const store = new LocalAttachmentStore(ctx, { dshHome: home });
      const s = server(store, { inputModalities: ['image'] });
      const input = params();
      if (format === 'jpeg') {
        input.data = (
          await readFile(
            new URL(
              '../../../packages/database/src/fixtures/reference-image.jpg',
              import.meta.url,
            ),
          )
        ).toString('base64');
        input.mediaType = 'image/jpeg';
        input.name = 'diagram.jpg';
      }
      const result = await referenceImageOperation(s, 'save', input);
      assert.ok(result.image);
      const blocks = referenceImageOutput.render(
        {},
        { content: 'source R1', image: result.image },
      );
      assert.deepEqual(blocks, [
        { type: 'text', text: 'source R1' },
        { type: 'image', attachment: result.image },
      ]);
      await ctx.root.fiber.dispose();
      const restoredContext = new Context();
      try {
        const restored = new LocalAttachmentStore(restoredContext, {
          dshHome: home,
        });
        const loaded = await restored.readImage(result.image);
        assert.equal(loaded.data.byteLength, result.image.bytes);
      } finally {
        await restoredContext.root.fiber.dispose();
      }
      assert.equal(result.image.width, 1);
      assert.match(result.image.attachmentId, /^sha256:[a-f0-9]{64}$/);
    } finally {
      await ctx.root.fiber.dispose();
      await rm(home, { recursive: true, force: true });
    }
  },
);
test('structured native error codes map without parsing text; storage faults stay failures', async () => {
  for (const [native, code, reason] of [
    ['INVALID_IMAGE', 'REFERENCE_READ_INVALID', 'image_decode'],
    ['IMAGE_TYPE_MISMATCH', 'REFERENCE_READ_INVALID', 'image_type_mismatch'],
    ['IMAGE_DIMENSION_TOO_LARGE', 'REFERENCE_READ_LIMIT', 'image_dimensions'],
    ['IMAGE_TOO_MANY_PIXELS', 'REFERENCE_READ_LIMIT', 'image_pixels'],
    ['TOO_MANY_IMAGES', 'REFERENCE_READ_LIMIT', 'native_image_budget'],
  ]) {
    const s = server(
      {
        saveImages: async () => {
          throw Object.assign(Error('unrelated text'), { code: native });
        },
      },
      { inputModalities: ['image'] },
    );
    assert.deepEqual(
      (await referenceImageOperation(s, 'save', params())).error,
      {
        code,
        reason,
        retryable: false,
        message: '原生图片服务无法接收这张图片，未返回图片内容。',
      },
    );
  }
  const fault = Object.assign(Error('storage failed'), {
    code: 'ATTACHMENT_WRITE_FAILED',
  });
  const s = server(
    {
      saveImages: async () => {
        throw fault;
      },
    },
    { inputModalities: ['image'] },
  );
  await assert.rejects(
    referenceImageOperation(s, 'save', params()),
    (error) => error === fault,
  );
  assert.equal(
    (
      await referenceImageOperation(s, 'route', {
        ...params(),
        deadlineAt: Date.now() - 1,
      })
    ).error.reason,
    'operation_budget',
  );
});
