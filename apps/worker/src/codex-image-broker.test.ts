import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexProviderClient } from './codex-search-broker.js';
import {
  CodexImageGenerationFailedError,
  requestCodexImage,
} from './codex-image-broker.js';

vi.mock('./codex-search-broker.js', () => ({
  createCodexProviderClient: vi.fn(),
}));

const input = {
  configuration: {
    connectionId: '52000000-0000-4000-8000-000000000001',
    workModel: 'gpt-5.6-luna' as const,
    reasoningEffort: 'xhigh' as const,
    timeoutMs: 300000,
    imagesEnabled: true,
    imageModel: 'gpt-image-2.5-sunburst' as const,
  },
  prompt: 'Synthetic portrait',
};
const metadata = {
  workModel: input.configuration.workModel,
  imageModel: input.configuration.imageModel,
  requestId: 'synthetic',
  usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: null },
};

describe('Codex image provider receipts', () => {
  afterEach(() => vi.resetAllMocks());
  it.each(['success', 'failed', 'invalid'] as const)(
    'handles %s receipt and closes the owned client without retry',
    async (mode) => {
      const raw =
        mode === 'success'
          ? { ...metadata, imageBase64: 'cG5n' }
          : {
              ...metadata,
              status: 'failed',
              ...(mode === 'invalid' ? { imageBase64: 'cG5n' } : {}),
            };
      const generateCodexImage = vi.fn(async () => raw);
      const close = vi.fn(async () => {});
      vi.mocked(createCodexProviderClient).mockResolvedValue({
        generateCodexImage,
        close,
      } as unknown as Awaited<ReturnType<typeof createCodexProviderClient>>);
      if (mode === 'success') {
        await expect(requestCodexImage(input)).resolves.toEqual(raw);
      } else if (mode === 'failed') {
        const failure = await requestCodexImage(input).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(CodexImageGenerationFailedError);
        expect(failure).toMatchObject({
          code: 'IMAGE_GENERATION_FAILED',
          retryable: false,
          receipt: raw,
        });
      } else {
        await expect(requestCodexImage(input)).rejects.toMatchObject({
          code: 'IMAGE_RESULT_UNKNOWN',
          retryable: false,
        });
      }
      expect(generateCodexImage).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );
});
