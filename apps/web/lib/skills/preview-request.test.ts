import { describe, expect, it } from 'vitest';
import {
  readSkillPreviewRequest,
  readSkillConfirmationRequest,
} from './preview-request';

describe('bounded browser Skill source requests', () => {
  it('reads bounded confirmation JSON and refuses oversized or malformed bodies', async () => {
    const request = (body: BodyInit, length?: string) =>
      new Request('http://localhost/confirm', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          ...(length ? { 'content-length': length } : {}),
        },
      });
    expect(
      await readSkillConfirmationRequest(request('{"requestId":"example"}')),
    ).toEqual({ requestId: 'example' });
    await expect(
      readSkillConfirmationRequest(request('{}', '11000000')),
    ).rejects.toThrow('source_invalid');
    await expect(
      readSkillConfirmationRequest(request('x'.repeat(11_000_000), '2')),
    ).rejects.toThrow('source_invalid');
    await expect(
      readSkillConfirmationRequest(request(new Uint8Array([0xff]))),
    ).rejects.toThrow('preview_invalid');
    await expect(readSkillConfirmationRequest(request('{'))).rejects.toThrow(
      'preview_invalid',
    );
  });
  it('reads JSON source metadata without inventing archive bytes', async () => {
    const input = {
      source: { kind: 'github', url: 'https://github.com/acme/skills' },
    };
    const request = new Request('http://localhost/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(await readSkillPreviewRequest(request)).toEqual({ input });
  });
  it('rejects an actual oversized JSON stream even with an undersized Content-Length', async () => {
    const request = new Request('http://localhost/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '2' },
      body: JSON.stringify('x'.repeat(16_384)),
    });
    await expect(readSkillPreviewRequest(request)).rejects.toThrow(
      'source_invalid',
    );
  });
  it('keeps exact uploaded bytes and the submitted filename', async () => {
    const bytes = new Uint8Array([0, 255, 42]);
    const form = new FormData();
    form.set('input', JSON.stringify({ target: { operation: 'install' } }));
    form.set('file', new Blob([bytes]), 'weekly.zip');
    const request = new Request('http://localhost/preview', {
      method: 'POST',
      body: form,
    });
    expect(await readSkillPreviewRequest(request)).toEqual({
      input: {
        target: { operation: 'install' },
        source: { kind: 'zip', fileName: 'weekly.zip' },
      },
      archive: bytes,
    });
  });
  it('preserves genuine failures while reading the request stream', async () => {
    const failure = new TypeError('synthetic stream failure');
    const request = new Request('http://localhost/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.error(failure);
        },
      }),
      duplex: 'half',
    } as RequestInit);
    await expect(readSkillPreviewRequest(request)).rejects.toBe(failure);
  });
  it('rejects duplicate file parts and conflicting source metadata', async () => {
    for (const duplicate of [true, false]) {
      const form = new FormData();
      form.set(
        'input',
        JSON.stringify(
          duplicate
            ? {}
            : {
                source: {
                  kind: 'github',
                  url: 'https://github.com/acme/skills',
                },
              },
        ),
      );
      form.append('file', new Blob(['first']), 'first.zip');
      if (duplicate) form.append('file', new Blob(['second']), 'second.zip');
      const request = new Request('http://localhost/preview', {
        method: 'POST',
        body: form,
      });
      await expect(readSkillPreviewRequest(request)).rejects.toThrow(
        'source_invalid',
      );
    }
  });
});
