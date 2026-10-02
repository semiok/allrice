import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type RuntimeLocalPythonArtifactMetadata,
  type RuntimeLocalPythonPayload,
} from '@allrice/contracts';
import { localPythonHttpTransport } from './local-python-client.js';
import { localPythonSupervisor } from './local-python-supervisor.js';

// PR1a's actual fixed-image/synthetic CSV chart. No tenant data or decoder.
const bytes = readFileSync(
  new URL(
    '../../web/lib/runtime/fixtures/met166-cjk-chart.png',
    import.meta.url,
  ),
);
const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const png = {
  checker: 'pillow-11.3.0' as const,
  checksum,
  width: 1080,
  height: 600,
};
const output: RuntimeLocalPythonPayload['arguments']['outputs'][number] = {
  path: '费用/中文图.png',
  fileName: '中文图.png',
  format: 'png',
  mediaType: 'image/png',
  objectId: randomUUID(),
};
const metadata: RuntimeLocalPythonArtifactMetadata = {
  checksum,
  sizeBytes: bytes.length,
  mediaType: 'image/png',
  validation: 'trusted_png',
  png,
};
const transport = () =>
  localPythonHttpTransport({
    server: 'https://synthetic.invalid',
    token: 'synthetic-device-token',
    id: 'synthetic-operation',
    leaseToken: 'synthetic-operation-lease',
  });
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());

describe('managed Python trusted PNG receipt and byte transport', () => {
  it('forwards the actual PNG bytes and checker report and accepts separately parsed/reordered nested metadata', async () => {
    const fetch = vi.fn(async (_url: URL, request: RequestInit) => {
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('error');
      expect(Buffer.from(request.body as Uint8Array)).toEqual(bytes);
      const headers = new Headers(request.headers);
      expect(headers.get('authorization')).toBe(
        'Bearer synthetic-device-token',
      );
      expect(headers.get('x-allrice-lease')).toBe('synthetic-operation-lease');
      expect(
        JSON.parse(decodeURIComponent(headers.get('x-allrice-file')!)),
      ).toEqual(metadata);
      return Response.json({
        artifact: {
          collected: true,
          ...output,
          ...metadata,
          png: {
            height: png.height,
            width: png.width,
            checksum: png.checksum,
            checker: png.checker,
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    expect(await transport().upload(output, metadata, bytes, signal())).toEqual(
      { ...output, ...metadata, collected: true },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      `https://synthetic.invalid/api/v1/bridge/device/file-transfers/operation/synthetic-operation?objectId=${output.objectId}`,
    );
  });
  it.each([
    'width',
    'checksum',
    'objectId',
    'mime',
    'collected',
    'missing_report',
  ])(
    'does not acknowledge a changed or missing server receipt (%s)',
    async (change) => {
      const artifact = {
        ...output,
        ...metadata,
        png: { ...png },
        collected: true,
      };
      if (change === 'width') artifact.png.width++;
      if (change === 'checksum')
        artifact.png.checksum = `sha256:${'1'.repeat(64)}`;
      if (change === 'objectId') artifact.objectId = randomUUID();
      if (change === 'mime') artifact.mediaType = 'text/plain';
      if (change === 'collected') artifact.collected = false;
      const receipt: Record<string, unknown> = { ...artifact };
      if (change === 'missing_report') delete receipt.png;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ artifact: receipt })),
      );
      await expect(
        transport().upload(output, metadata, bytes, signal()),
      ).rejects.toThrow();
    },
  );
  it.each(['actual_bytes', 'report_checksum', 'missing_report'])(
    'rejects inconsistent %s before sending any upload',
    async (change) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const selected = { ...metadata, png: { ...png } };
      if (change === 'report_checksum')
        selected.png.checksum = `sha256:${'1'.repeat(64)}`;
      const wrong: RuntimeLocalPythonArtifactMetadata = { ...selected };
      if (change === 'missing_report') delete wrong.png;
      await expect(
        transport().upload(
          output,
          wrong,
          change === 'actual_bytes' ? bytes.subarray(0, -1) : bytes,
          signal(),
        ),
      ).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_CHANGED' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('bounds acknowledgment JSON and treats a lost upload response as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(' '.repeat(4097))),
    );
    await expect(
      transport().upload(output, metadata, bytes, signal()),
    ).rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_UNKNOWN' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      transport().upload(output, metadata, bytes, signal()),
    ).rejects.toMatchObject({ code: 'ARTIFACT_UPLOAD_UNKNOWN' });
  });
  it('keeps the original exact-checksum input byte admission independent from PNG output metadata', async () => {
    const input = {
      path: '同图.png',
      objectId: randomUUID(),
      checksum,
      sizeBytes: bytes.length,
      mediaType: 'image/png',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(bytes), {
            headers: {
              'x-allrice-checksum': checksum,
              'content-length': String(bytes.length),
            },
          }),
      ),
    );
    expect(await transport().download(input, signal())).toEqual(bytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(bytes.subarray(0, -1)), {
            headers: {
              'x-allrice-checksum': checksum,
              'content-length': String(bytes.length),
            },
          }),
      ),
    );
    await expect(transport().download(input, signal())).rejects.toMatchObject({
      code: 'INPUT_VERSION_CHANGED',
    });
  });
  it('executes only the production pure report function and rejects malformed, oversized, false-dimension or wrong-byte checker stdout', () => {
    const cases = [
      { raw: JSON.stringify(png), checksum, pass: true },
      {
        raw: JSON.stringify(png),
        checksum: `sha256:${'1'.repeat(64)}`,
        pass: false,
      },
      { raw: ' '.repeat(1025), checksum, pass: false },
      { raw: '{"checker":', checksum, pass: false },
      {
        raw: JSON.stringify({ ...png, checker: 'tenant' }),
        checksum,
        pass: false,
      },
      { raw: JSON.stringify({ ...png, width: true }), checksum, pass: false },
      { raw: JSON.stringify({ ...png, width: 8193 }), checksum, pass: false },
      {
        raw: JSON.stringify({ ...png, width: 8192, height: 8192 }),
        checksum,
        pass: false,
      },
      {
        raw: JSON.stringify({ ...png, imagePath: '/tmp/tenant' }),
        checksum,
        pass: false,
      },
    ];
    // Parse the whole shipped supervisor but execute only png_report. The
    // harness cannot chmod/chown, setuid, launch tenant code or touch a VM.
    const result = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        `
import ast,json,sys
case=json.load(sys.stdin)
tree=ast.parse(case['source'])
function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='png_report')
module=ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[]))
scope={'json':json}
exec(compile(module,'trusted-supervisor-png-report','exec'),scope)
results=[]
for item in case['cases']:
    try:
        report=scope['png_report'](item['raw'].encode('utf-8'),item['checksum'])
        results.append({'pass':True,'report':report})
    except (ValueError,UnicodeError,TypeError):results.append({'pass':False})
print(json.dumps(results))
`,
      ],
      {
        input: JSON.stringify({ source: localPythonSupervisor, cases }),
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const actual = JSON.parse(result.stdout) as {
      pass: boolean;
      report?: typeof png;
    }[];
    expect(actual.map((entry) => entry.pass)).toEqual(
      cases.map((entry) => entry.pass),
    );
    expect(actual[0]!.report).toEqual(png);
  });
});
