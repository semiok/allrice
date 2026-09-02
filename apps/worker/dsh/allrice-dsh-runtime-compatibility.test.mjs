import { describe, expect, it } from 'vitest';

import {
  admitDshPromptImageBlocks,
  steerDshAgent,
} from './allrice-dsh-runtime-compatibility.mjs';

describe('AllRice DSH runtime compatibility', () => {
  it('admits canonical wire images and preserves their block order', async () => {
    const savedBatches = [];
    const references = [
      { id: 'image-one', mediaType: 'image/png' },
      { id: 'image-two', mediaType: 'image/jpeg' },
    ];
    const attachments = {
      async saveImages(inputs) {
        savedBatches.push(inputs);
        return references;
      },
    };

    await expect(
      admitDshPromptImageBlocks(attachments, [
        { data: 'AQI=', mediaType: 'image/png', name: 'one.png' },
        { data: 'AwQ=', mediaType: 'image/jpeg' },
      ]),
    ).resolves.toEqual([
      { type: 'image', attachment: references[0] },
      { type: 'image', attachment: references[1] },
    ]);
    expect(savedBatches).toHaveLength(1);
    expect(
      savedBatches[0].map((input) => ({
        bytes: [...input.data],
        mediaType: input.mediaType,
        name: input.name,
      })),
    ).toEqual([
      { bytes: [1, 2], mediaType: 'image/png', name: 'one.png' },
      { bytes: [3, 4], mediaType: 'image/jpeg', name: undefined },
    ]);
  });

  it('keeps upstream image-admission failures intact', async () => {
    await expect(
      admitDshPromptImageBlocks(
        {
          async saveImages() {
            throw new Error('saveImages must not run');
          },
        },
        [{ data: 'not-canonical-base64', mediaType: 'image/png' }],
      ),
    ).rejects.toMatchObject({ code: 'INVALID_IMAGE_BASE64' });
  });

  it('creates and submits one upstream user message for steering', () => {
    const messages = [];
    const messageId = steerDshAgent(
      {
        steer(message) {
          messages.push(message);
        },
      },
      'Continue with the revised scope.',
    );

    expect(messageId).toEqual(expect.any(String));
    expect(messageId).not.toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: 'Continue with the revised scope.' }],
      source: { kind: 'user' },
    });
  });
});
