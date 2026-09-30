/* global TextEncoder, Response, ReadableStream */
import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { generateCodexImage } from './allrice-codex-images.mjs';
const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic' } })).toString('base64url')}.test`;
const models = { getAuth: async () => ({ auth: { apiKey: token } }) };
const params = {
  workModel: 'gpt-5.6-luna',
  imageModel: 'gpt-image-2.5-flare',
  prompt: 'Synthetic circle',
};
const completed = {
  type: 'response.completed',
  response: {
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 1 },
    },
  },
};
const output = {
  type: 'response.output_item.done',
  item: { type: 'image_generation_call', result: 'cG5n' },
};
function stream(events) {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7)
          c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
    { headers: { 'x-request-id': 'synthetic' } },
  );
}
describe('Codex image transport', () => {
  const failedImage = {
    type: 'response.output_item.done',
    item: {
      id: 'synthetic-image',
      type: 'image_generation_call',
      status: 'failed',
    },
  };
  it('records an explicitly failed image only after the response completes', async () => {
    const request = vi.fn(async () =>
      stream([failedImage, failedImage, completed]),
    );
    await expect(generateCodexImage(models, params, request)).resolves.toEqual({
      status: 'failed',
      workModel: params.workModel,
      imageModel: params.imageModel,
      requestId: 'synthetic',
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
    });
    expect(request).toHaveBeenCalledTimes(1);
    await expect(
      generateCodexImage(models, params, async () => stream([failedImage])),
    ).rejects.toThrow('IMAGE_RESULT_UNKNOWN');
    await expect(
      generateCodexImage(models, params, async () => stream([completed])),
    ).rejects.toThrow('IMAGE_RESULT_UNKNOWN');
  });
  it('accepts a later successful image in the same response after a failed attempt', async () => {
    const request = vi.fn(async () => stream([failedImage, output, completed]));
    await expect(
      generateCodexImage(models, params, request),
    ).resolves.toMatchObject({
      imageBase64: 'cG5n',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['gpt-6-sol', 'gpt-6-luna'])(
    'forwards %s through image generation without substituting an old model',
    async (workModel) => {
      const request = vi.fn(async () => stream([output, completed]));
      const receipt = await generateCodexImage(
        models,
        { ...params, workModel },
        request,
      );
      expect(receipt.workModel).toBe(workModel);
      expect(JSON.parse(request.mock.calls[0][1].body).model).toBe(workModel);
    },
  );
  it.each(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])(
    'uses managed OAuth and %s with complete SSE receipts',
    async (imageModel) => {
      const request = vi.fn(async () => stream([output, completed]));
      const receipt = await generateCodexImage(
        models,
        {
          ...params,
          imageModel,
          source: { mediaType: 'image/png', data: 'cG5n' },
        },
        request,
      );
      expect(receipt).toMatchObject({
        imageBase64: 'cG5n',
        requestId: 'synthetic',
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
      });
      const [url, options] = request.mock.calls[0];
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      expect(JSON.parse(options.body)).toMatchObject({
        store: false,
        tools: [{ model: imageModel, action: 'edit' }],
      });
      expect(options.headers['chatgpt-account-id']).toBe('synthetic');
    },
  );
  it.each([401, 403, 429, 400, 500])(
    'does not retry HTTP %i or expose its body',
    async (status) => {
      const request = vi.fn(
        async () => new Response('private-upstream-detail', { status }),
      );
      await expect(generateCodexImage(models, params, request)).rejects.toThrow(
        /^IMAGE_/,
      );
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('never accepts a partial image or a failed completion', async () => {
    await expect(
      generateCodexImage(models, params, async () => stream([output])),
    ).rejects.toThrow('IMAGE_RESULT_UNKNOWN');
    await expect(
      generateCodexImage(models, params, async () =>
        stream([output, { type: 'response.failed' }]),
      ),
    ).rejects.toThrow('IMAGE_GENERATION_FAILED');
  });
  it('rejects unavailable models and duplicate image results', async () => {
    const request = vi.fn();
    await expect(
      generateCodexImage(
        models,
        { ...params, imageModel: 'unverified' },
        request,
      ),
    ).rejects.toThrow('IMAGE_INPUT_INVALID');
    expect(request).not.toHaveBeenCalled();
    await expect(
      generateCodexImage(models, params, async () =>
        stream([output, output, completed]),
      ),
    ).rejects.toThrow('IMAGE_RESULT_INVALID');
  });
});
