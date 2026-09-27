import { describe, expect, it } from 'vitest';
import { ImageToolInputSchema, resolveImageModel } from './image-generation.ts';

describe('image model selection', () => {
  const flare = 'gpt-image-2.5-flare';
  const sunburst = 'gpt-image-2.5-sunburst';
  const source = {
    objectId: '00000000-0000-4000-8000-000000000001',
    checksum: `sha256:${'a'.repeat(64)}`,
  };
  it('uses the employee choice for demanding generation and fast edits', () => {
    expect(
      resolveImageModel({ imageModel: 'auto' }, { imageModel: sunburst }),
    ).toBe(sunburst);
    expect(
      resolveImageModel({ imageModel: 'auto' }, { imageModel: flare, source }),
    ).toBe(flare);
  });
  it('keeps older calls usable and respects a fixed platform choice', () => {
    expect(resolveImageModel({ imageModel: 'auto' }, {})).toBe(flare);
    expect(resolveImageModel({ imageModel: 'auto' }, { source })).toBe(
      sunburst,
    );
    expect(
      resolveImageModel(
        { imageModel: flare },
        { imageModel: sunburst, source },
      ),
    ).toBe(flare);
    expect(resolveImageModel({ imageModel: sunburst }, {})).toBe(sunburst);
  });
  it('rejects an arbitrary model before dispatch', () => {
    expect(
      ImageToolInputSchema.safeParse({
        prompt: 'test',
        fileName: 'test.png',
        imageModel: 'unavailable',
      }).success,
    ).toBe(false);
  });
});
