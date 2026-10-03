import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { imageSize } from 'image-size';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { readPdfDocument } from '@allrice/office-runtime/pdf-reader';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DocumentTransformError,
  documentTransformMaximumFileBytes,
  documentTransformMaximumPdfPages,
  transformDocuments,
  type DocumentTransformRequest,
} from './document-transforms.ts';

const fixedLoader = vi.hoisted(() => vi.fn());
vi.mock('./local-pdf-resources.js', () => ({
  loadFixedPdfResources: fixedLoader,
}));

// Test-only loader uses the exact native version already in the sealed PDF
// runtime. Production has no node_modules fallback (the source loader throws).
const officeRequire = createRequire(
  new URL('../../../packages/office-runtime/package.json', import.meta.url),
);
const canvasRequire = createRequire(officeRequire.resolve('pdf-parse'));
const canvasEntry = canvasRequire.resolve('@napi-rs/canvas');
const canvasLibrary = canvasRequire('@napi-rs/canvas') as {
  createCanvas: (
    width: number,
    height: number,
  ) => {
    width: number;
    height: number;
    getContext: (kind: '2d') => {
      fillStyle: string;
      fillRect: (x: number, y: number, width: number, height: number) => void;
      drawImage: (image: unknown, x: number, y: number) => void;
      getImageData: (
        x: number,
        y: number,
        width: number,
        height: number,
      ) => { data: Uint8ClampedArray };
    };
    encode: (
      format: 'png' | 'jpeg' | 'webp',
      quality?: number,
    ) => Promise<Buffer>;
    encodeStream: (
      format: 'png' | 'jpeg' | 'webp',
      quality?: number,
    ) => ReadableStream<Uint8Array>;
  };
  loadImage: (bytes: Uint8Array) => Promise<{ width: number; height: number }>;
};
const source = (bytes: Uint8Array, path = 'source.pdf') => ({ path, bytes });
const pdfFixture = (name: string) =>
  readFileSync(new URL(`../../../tests/fixtures/pdf/${name}`, import.meta.url));

async function numberedPdf(numbers: number[]) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const number of numbers) {
    const page = document.addPage([200 + number, 300]);
    page.drawText(`page-${number}`, { x: 20, y: 250, font });
  }
  return document.save({ updateFieldAppearances: false });
}
async function pixels(bytes: Uint8Array) {
  const image = await canvasLibrary.loadImage(bytes);
  const canvas = canvasLibrary.createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  const values = canvas
    .getContext('2d')
    .getImageData(0, 0, image.width, image.height).data;
  return { width: image.width, height: image.height, values: [...values] };
}
async function transparentPng() {
  const canvas = canvasLibrary.createCanvas(4, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 2, 2);
  return canvas.encode('png');
}

beforeEach(() => {
  fixedLoader.mockReset();
  fixedLoader.mockReturnValue({
    root: resolve(dirname(canvasEntry), '../../..'),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('PDF byte transforms through pdf-lib', () => {
  it('merges sources in caller order and retains Chinese content and original bytes', async () => {
    const chinese = pdfFixture('01-chinese-multipage-digital.pdf');
    const original = Buffer.from(chinese);
    const tail = await numberedPdf([4]);
    const [output] = await transformDocuments(
      [source(chinese, '中文.pdf'), source(tail, 'tail.pdf')],
      { kind: 'pdf_merge', name: '合并.pdf' },
    );
    expect(output).toMatchObject({
      name: '合并.pdf',
      mediaType: 'application/pdf',
    });
    const read = await readPdfDocument({
      bytes: Uint8Array.from(output!.bytes),
    });
    expect(read.totalPages).toBe(4);
    expect(read.units[0]!.text).toContain('青松办公室');
    expect(read.units[1]!.text).toContain('-200.00');
    expect(read.units[2]!.text).toContain('远山资料室');
    expect(read.units[3]!.text).toContain('page-4');
    expect(chinese.equals(original)).toBe(true);
    expect(fixedLoader).not.toHaveBeenCalled();
  });

  it('extracts precisely the requested physical pages in unsorted caller order', async () => {
    const [output] = await transformDocuments(
      [source(pdfFixture('01-chinese-multipage-digital.pdf'))],
      { kind: 'pdf_extract', name: 'pages.pdf', pages: [3, 1] },
    );
    const read = await readPdfDocument({
      bytes: Uint8Array.from(output!.bytes),
    });
    expect(read.totalPages).toBe(2);
    expect(read.units[0]!.text).toContain('远山资料室');
    expect(read.units[1]!.text).toContain('青松办公室');
    expect(read.text).not.toContain('星河实验室');
  });

  it('rotates selected pages relative to existing rotation without rasterizing', async () => {
    const original = await PDFDocument.load(await numberedPdf([1, 2]));
    original.getPage(1).setRotation(degrees(270));
    const [output] = await transformDocuments([source(await original.save())], {
      kind: 'pdf_rotate',
      name: 'rotated.pdf',
      pages: [2],
      degrees: 180,
    });
    const observed = await PDFDocument.load(output!.bytes);
    expect(observed.getPages().map((page) => page.getRotation().angle)).toEqual(
      [0, 90],
    );
    expect(observed.getPages().map((page) => page.getWidth())).toEqual([
      201, 202,
    ]);
    expect((await readPdfDocument({ bytes: output!.bytes })).text).toContain(
      'page-2',
    );
  });

  it('preserves image-only scanned pages as page content without inventing OCR', async () => {
    const [output] = await transformDocuments(
      [source(pdfFixture('04-scanned-image-only.pdf'))],
      { kind: 'pdf_extract', name: 'scan.pdf', pages: [1] },
    );
    const read = await readPdfDocument({
      bytes: Uint8Array.from(output!.bytes),
    });
    expect(read.totalPages).toBe(1);
    expect(read.quality).toBe('no_extractable_text');
    const document = await PDFDocument.load(output!.bytes);
    expect(
      document.getPage(0).node.Resources()!.has(PDFName.of('XObject')),
    ).toBe(true);
  });

  it('rejects an independently encrypted fixture instead of bypassing encryption', async () => {
    await expect(
      transformDocuments([source(pdfFixture('05-password-protected.pdf'))], {
        kind: 'pdf_rotate',
        name: 'out.pdf',
        degrees: 90,
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_PDF_ENCRYPTED' });
  });

  it.each([
    'form',
    'xfa',
    'signature',
    'direct-signature',
    'widget',
    'perms',
  ] as const)('rejects unsupported %s preservation inputs', async (kind) => {
    const document = await PDFDocument.load(await numberedPdf([1]));
    if (kind === 'form') document.getForm().createTextField('field');
    if (kind === 'xfa')
      document.catalog.set(
        PDFName.of('AcroForm'),
        document.context.obj({ XFA: 'unsupported' }),
      );
    if (kind === 'signature')
      document.context.register(
        document.context.obj({ Type: 'Sig', ByteRange: [0, 1, 2, 3] }),
      );
    if (kind === 'direct-signature')
      document.catalog.set(
        PDFName.of('Private'),
        document.context.obj({ Proof: { ByteRange: [0, 1, 2, 3] } }),
      );
    if (kind === 'widget')
      document.context.register(
        document.context.obj({ Type: 'Annot', Subtype: 'Widget' }),
      );
    if (kind === 'perms')
      document.catalog.set(PDFName.of('Perms'), document.context.obj({}));
    await expect(
      transformDocuments([source(await document.save())], {
        kind: 'pdf_extract',
        name: 'out.pdf',
        pages: [1],
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_PDF_UNSUPPORTED' });
  });

  it.each([[0], [-1], [3], [1.5], [], [1, 1]])(
    'rejects invalid page selections %j',
    async (...pages) => {
      await expect(
        transformDocuments([source(await numberedPdf([1, 2]))], {
          kind: 'pdf_extract',
          name: 'out.pdf',
          pages,
        }),
      ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_INVALID_REQUEST' });
    },
  );

  it('rejects excessive actual page count before copying any page', async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index <= documentTransformMaximumPdfPages; index++)
      document.addPage([10, 10]);
    await expect(
      transformDocuments([source(await document.save())], {
        kind: 'pdf_merge',
        name: 'out.pdf',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
  });

  it('rejects bad PDF bytes and multiple-source extract requests', async () => {
    await expect(
      transformDocuments([source(Buffer.from('invalid'))], {
        kind: 'pdf_merge',
        name: 'out.pdf',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_INVALID_SOURCE' });
    await expect(
      transformDocuments(
        [source(new Uint8Array([1])), source(new Uint8Array([2]), 'other.pdf')],
        {
          kind: 'pdf_extract',
          name: 'out.pdf',
          pages: [1],
        },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_INVALID_REQUEST' });
  });

  it('enforces the actual serialized PDF output byte limit', async () => {
    const document = await PDFDocument.create({ updateMetadata: false });
    const page = document.addPage([20, 20]);
    // Opaque uncompressed streams exercise writer size, not a fake save result.
    page.node.set(
      PDFName.of('Contents'),
      document.context.register(
        document.context.stream(new Uint8Array(4_600_000).fill(32)),
      ),
    );
    const bytes = await document.save();
    expect(bytes.byteLength).toBeLessThan(documentTransformMaximumFileBytes);
    await expect(
      transformDocuments([source(bytes), source(bytes, 'second.pdf')], {
        kind: 'pdf_merge',
        name: 'out.pdf',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
  });
});

describe('image byte transforms through the fixed Canvas library', () => {
  it.each(['png', 'jpeg', 'webp'] as const)(
    'really encodes and decodes %s at exact requested dimensions',
    async (format) => {
      const [output] = await transformDocuments(
        [source(await transparentPng(), '原图.png')],
        {
          kind: 'image_resize',
          width: 8,
          height: 4,
          format,
          quality: 100,
        },
      );
      expect(output).toMatchObject({
        name: `原图.${format}`,
        mediaType: `image/${format}`,
      });
      const read = await pixels(output!.bytes);
      expect([read.width, read.height]).toEqual([8, 4]);
      expect(imageSize(output!.bytes).type).toBe(
        format === 'jpeg' ? 'jpg' : format,
      );
      // Bottom right came from transparent input: JPEG must have white, alpha
      // formats retain transparency instead of silently flattening onto black.
      const corner = read.values.slice(-4);
      if (format === 'jpeg') {
        expect(corner[3]).toBe(255);
        expect(corner.slice(0, 3).every((channel) => channel > 240)).toBe(true);
      } else expect(corner[3]).toBe(0);
    },
  );

  it.each(['png', 'jpeg', 'webp'] as const)(
    'really decodes %s inputs regardless of file extension',
    async (format) => {
      const canvas = canvasLibrary.createCanvas(4, 2);
      canvas.getContext('2d').fillStyle = '#ff0000';
      canvas.getContext('2d').fillRect(0, 0, 4, 2);
      const input = await canvas.encode(format, 100);
      const [output] = await transformDocuments(
        [source(input, 'wrong.extension')],
        { kind: 'image_format', format: 'png' },
      );
      const read = await pixels(output!.bytes);
      expect([read.width, read.height]).toEqual([4, 2]);
      expect(read.values[0]).toBeGreaterThan(240);
      expect(read.values[3]).toBe(255);
    },
  );

  it('normalizes actual JPEG EXIF orientation into pixels and discards EXIF metadata', async () => {
    const canvas = canvasLibrary.createCanvas(30, 20);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ff0000';
    context.fillRect(0, 0, 30, 10);
    context.fillStyle = '#0000ff';
    context.fillRect(0, 10, 30, 10);
    const jpeg = await canvas.encode('jpeg', 100);
    // Fixed synthetic EXIF orientation=6 (clockwise 90), independently authored
    // TIFF tag bytes. Production neither parses nor writes EXIF itself.
    const exif = Buffer.from(
      'ffe1002245786966000049492a0008000000010012010300010000000600000000000000',
      'hex',
    );
    const oriented = Buffer.concat([
      jpeg.subarray(0, 2),
      exif,
      jpeg.subarray(2),
    ]);
    expect(imageSize(oriented).orientation).toBe(6);
    const [output] = await transformDocuments(
      [source(oriented, 'oriented.jpg')],
      { kind: 'image_format', format: 'png' },
    );
    const read = await pixels(output!.bytes);
    expect([read.width, read.height]).toEqual([20, 30]);
    expect(read.values[2]).toBeGreaterThan(240); // Former bottom becomes left.
    expect(imageSize(output!.bytes).orientation).toBeUndefined();
  });

  it('fails closed when the sealed runtime is absent and never loads host fallback', async () => {
    fixedLoader.mockImplementation(() => {
      throw Error('PDF_FIXED_RUNTIME_REQUIRES_SEA');
    });
    const decode = vi.spyOn(canvasLibrary, 'loadImage');
    await expect(
      transformDocuments([source(await transparentPng(), 'image.png')], {
        kind: 'image_format',
        format: 'png',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_RUNTIME_UNAVAILABLE' });
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(['NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI'])(
    'rejects inherited native replacement %s before calling the fixed loader',
    async (variable) => {
      vi.stubEnv(variable, 'untrusted');
      await expect(
        transformDocuments([source(await transparentPng(), 'image.png')], {
          kind: 'image_format',
          format: 'png',
        }),
      ).rejects.toMatchObject({
        code: 'DOCUMENT_TRANSFORM_RUNTIME_UNAVAILABLE',
      });
      expect(fixedLoader).not.toHaveBeenCalled();
    },
  );

  it('accepts exactly 32 byte sources and returns independently named real images', async () => {
    const bytes = await transparentPng();
    const original = Buffer.from(bytes);
    const outputs = await transformDocuments(
      Array.from({ length: 32 }, (_, index) => source(bytes, `${index}.png`)),
      { kind: 'image_format', format: 'webp' },
    );
    expect(outputs).toHaveLength(32);
    expect(outputs.map((output) => output.name)).toEqual(
      Array.from({ length: 32 }, (_, index) => `${index}.webp`),
    );
    for (const output of outputs)
      expect(imageSize(output.bytes)).toMatchObject({
        type: 'webp',
        width: 4,
        height: 2,
      });
    expect(bytes.equals(original)).toBe(true);
  });

  it('rejects SVG and corrupt images before invoking native decode', async () => {
    for (const bytes of [
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      ),
      Buffer.from('invalid'),
    ]) {
      await expect(
        transformDocuments([source(bytes, 'pretend.png')], {
          kind: 'image_format',
          format: 'png',
        }),
      ).rejects.toBeInstanceOf(DocumentTransformError);
    }
    expect(fixedLoader).not.toHaveBeenCalled();
  });

  it('rejects actual encoded dimensions and cumulative pixels before decode', async () => {
    const tooWide = await canvasLibrary.createCanvas(8193, 1).encode('png');
    await expect(
      transformDocuments([source(tooWide, 'wide.png')], {
        kind: 'image_format',
        format: 'png',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
    const square = await canvasLibrary.createCanvas(2000, 2000).encode('png');
    await expect(
      transformDocuments(
        Array.from({ length: 17 }, (_, index) =>
          source(square, `${index}.png`),
        ),
        { kind: 'image_format', format: 'png' },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
    expect(fixedLoader).not.toHaveBeenCalled();
  });

  it('rejects output dimensions and cumulative pixels before decode', async () => {
    const bytes = await transparentPng();
    await expect(
      transformDocuments([source(bytes, 'image.png')], {
        kind: 'image_resize',
        width: 4001,
        height: 4001,
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
    await expect(
      transformDocuments(
        Array.from({ length: 32 }, (_, index) => source(bytes, `${index}.png`)),
        { kind: 'image_resize', width: 1600, height: 1600 },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
    expect(fixedLoader).not.toHaveBeenCalled();
  });

  it('counts actual image encoding stream bytes and cancels over-limit output', async () => {
    const input = await transparentPng();
    const realCreateCanvas = canvasLibrary.createCanvas;
    const cancel = vi.fn();
    vi.spyOn(canvasLibrary, 'createCanvas').mockImplementation(
      (width, height) => {
        const canvas = realCreateCanvas(width, height);
        canvas.encodeStream = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(9_000_001));
            },
            cancel,
          });
        return canvas;
      },
    );
    await expect(
      transformDocuments([source(input, 'image.png')], {
        kind: 'image_format',
        format: 'png',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects output basename collisions across separate source directories', async () => {
    const bytes = await transparentPng();
    await expect(
      transformDocuments(
        [source(bytes, 'a/photo.png'), source(bytes, 'b/PHOTO.jpeg')],
        { kind: 'image_format', format: 'webp' },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_NAME_CONFLICT' });
    expect(fixedLoader).not.toHaveBeenCalled();
  });
});

describe('batch, name, authority and cancellation boundaries', () => {
  it.each([
    '../source.pdf',
    '/source.pdf',
    'C:source.pdf',
    'dir\\source.pdf',
    'bad\u0000.pdf',
  ])('rejects unsafe path %j', async (path) => {
    await expect(
      transformDocuments([source(new Uint8Array([1]), path)], {
        kind: 'pdf_merge',
        name: 'out.pdf',
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_UNSAFE_PATH' });
  });

  it('rejects duplicate source names and unsafe or mismatched PDF output names', async () => {
    await expect(
      transformDocuments(
        [
          source(new Uint8Array([1]), 'A.pdf'),
          source(new Uint8Array([1]), 'a.pdf'),
        ],
        { kind: 'pdf_merge', name: 'out.pdf' },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_NAME_CONFLICT' });
    for (const name of ['../out.pdf', 'out.png'])
      await expect(
        transformDocuments([source(new Uint8Array([1]))], {
          kind: 'pdf_merge',
          name,
        }),
      ).rejects.toBeInstanceOf(DocumentTransformError);
  });

  it('rejects excessive single bytes, aggregate bytes and file count before library work', async () => {
    const bytes = new Uint8Array(documentTransformMaximumFileBytes);
    for (const sources of [
      [source(new Uint8Array(documentTransformMaximumFileBytes + 1))],
      Array.from({ length: 15 }, (_, index) => source(bytes, `${index}.pdf`)),
      Array.from({ length: 33 }, (_, index) =>
        source(new Uint8Array([1]), `${index}.pdf`),
      ),
    ])
      await expect(
        transformDocuments(sources, { kind: 'pdf_merge', name: 'out.pdf' }),
      ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_LIMIT' });
    expect(fixedLoader).not.toHaveBeenCalled();
  });

  it('rejects invalid quality, format, dimensions and unknown operations', async () => {
    const input = [source(await transparentPng(), 'image.png')];
    for (const request of [
      { kind: 'image_format', format: 'gif' },
      { kind: 'image_format', format: 'png', quality: 101 },
      { kind: 'image_resize', width: 0, height: 2 },
      { kind: 'arbitrary' },
    ])
      await expect(
        transformDocuments(input, request as DocumentTransformRequest),
      ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_INVALID_REQUEST' });
    expect(fixedLoader).not.toHaveBeenCalled();
  });

  it('does no decoder work when initial authorization is denied or throws', async () => {
    for (const authorize of [
      async () => false,
      async () => {
        throw Error('private');
      },
    ])
      await expect(
        transformDocuments(
          [source(new Uint8Array([1]))],
          { kind: 'pdf_merge', name: 'out.pdf' },
          { authorize },
        ),
      ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_AUTHORITY_LOST' });
  });

  it('returns canceled while an authorization request remains pending', async () => {
    const controller = new AbortController();
    const result = transformDocuments(
      [source(new Uint8Array([1]))],
      { kind: 'pdf_merge', name: 'out.pdf' },
      {
        signal: controller.signal,
        authorize: () => new Promise<boolean>(() => {}),
      },
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: 'DOCUMENT_TRANSFORM_CANCELED',
    });
  });

  it('rechecks authorization after actual native decoding and refuses any output', async () => {
    const input = await transparentPng();
    let allowed = true;
    const original = canvasLibrary.loadImage;
    vi.spyOn(canvasLibrary, 'loadImage').mockImplementation(async (bytes) => {
      const image = await original(bytes);
      allowed = false;
      return image;
    });
    await expect(
      transformDocuments(
        [source(input, 'image.png')],
        { kind: 'image_format', format: 'png' },
        { authorize: async () => allowed },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_AUTHORITY_LOST' });
  });

  it('aborts a pending output stream and never delivers a completed partial image', async () => {
    const input = await transparentPng();
    const controller = new AbortController();
    const original = canvasLibrary.createCanvas;
    const cancel = vi.fn();
    vi.spyOn(canvasLibrary, 'createCanvas').mockImplementation(
      (width, height) => {
        const canvas = original(width, height);
        canvas.encodeStream = () =>
          new ReadableStream<Uint8Array>({
            pull() {
              queueMicrotask(() => controller.abort());
            },
            cancel,
          });
        return canvas;
      },
    );
    await expect(
      transformDocuments(
        [source(input, 'image.png')],
        { kind: 'image_format', format: 'png' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_CANCELED' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('observes mid-document PDF cancellation without returning partial merge bytes', async () => {
    const controller = new AbortController();
    const input = await numberedPdf([1, 2, 3]);
    let calls = 0;
    await expect(
      transformDocuments(
        [source(input)],
        { kind: 'pdf_merge', name: 'out.pdf' },
        {
          signal: controller.signal,
          authorize: async () => {
            if (++calls === 7) controller.abort();
            return true;
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_TRANSFORM_CANCELED' });
    expect(calls).toBe(7);
  });
});
