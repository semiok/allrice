import { randomUUID, createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudCommandSchema,
  CloudCommandInputSchema,
  cloudPythonImageV1,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { validatePngArtifact } from '@allrice/storage';
import JSZip from 'jszip';
import { CloudRunnerBackend } from './backend.js';
import { chartCsv, chartScript } from './python-charts.fixture.js';

const suite =
  process.env.ALLRICE_RUN_PYTHON_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const checksum = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const pngOutput = {
  path: 'chart.png',
  fileName: '中文费用图表.png',
  format: 'png',
};

suite('fixed Python Chinese charts in the actual gVisor cloud sandbox', () => {
  const backend = new CloudRunnerBackend();
  const attempts: string[] = [];
  afterEach(async () => {
    for (const id of attempts.splice(0)) {
      await backend.stop(id);
      await backend.cleanup(id);
    }
  });
  async function run(
    script: string,
    extra: Record<string, unknown> = {},
    inputBytes: Buffer[] = [],
    signal?: AbortSignal,
  ) {
    const attemptId = randomUUID();
    attempts.push(attemptId);
    const command = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      arguments: { language: 'python', script, ...extra },
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudPythonImageV1,
      runtime: 'runsc',
      network: 'none',
    });
    const result = await backend.execute(
      command,
      command.arguments.inputs.map((file, index) => ({
        path: file.path,
        contentBase64: inputBytes[index]!.toString('base64'),
      })),
      {
        attemptId,
        deadlineAt: new Date(Date.now() + 60000).toISOString(),
        maintainLease: async () => true,
        ...(signal ? { signal } : {}),
      },
    );
    return { attemptId, command, result };
  }
  async function chart() {
    const bytes = Buffer.from(chartCsv);
    return run(
      chartScript,
      {
        inputs: [
          {
            path: 'data.csv',
            objectId: randomUUID(),
            checksum: checksum(bytes),
          },
        ],
        outputs: [
          pngOutput,
          {
            path: 'data-quality.json',
            fileName: '数据质量.json',
            format: 'json',
          },
        ],
        limits: { timeoutMs: 60000, memoryMiB: 512, cpuMillis: 1000 },
      },
      [bytes],
    );
  }

  it('preflights both immutable images and preserves the legacy Node branch', async () => {
    expect((await backend.preflight(cloudPythonImageV1)).imageDigest).toBe(
      cloudPythonImageV1,
    );
    expect((await backend.preflight()).imageDigest).toBe(cloudToolchainImageV1);
    const attemptId = randomUUID();
    attempts.push(attemptId);
    const command = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      arguments: { script: 'console.log(process.version)' },
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudToolchainImageV1,
      runtime: 'runsc',
      network: 'none',
    });
    const result = await backend.execute(command, [], {
      attemptId,
      deadlineAt: new Date(Date.now() + 30000).toISOString(),
      maintainLease: async () => true,
    });
    expect(result.reason, result.output).toBe('completed');
    expect(result.output.trim()).toBe('v22.23.2');
    expect(command.arguments).not.toHaveProperty('language');
  }, 60000);

  it('plots exact numeric CSV rows, negative values and long CJK labels while reporting missing data', async () => {
    const { attemptId, command, result } = await chart();
    expect(result.reason, result.output).toBe('completed');
    expect(result.artifacts).toHaveLength(2);
    const png = result.artifacts.find((a) => a.path === 'chart.png')!;
    const bytes = Buffer.from(png.contentBase64, 'base64');
    expect(validatePngArtifact(bytes, png.png)).toMatchObject({
      width: 960,
      height: 480,
    });
    const data = JSON.parse(
      Buffer.from(
        result.artifacts.find((a) => a.path === 'data-quality.json')!
          .contentBase64,
        'base64',
      ).toString(),
    );
    expect(data).toMatchObject({
      rows: 3,
      plotted: 2,
      missing: 1,
      values: [10, -25],
      sum: -15,
      backend: 'Agg',
    });
    expect(data.font).toContain('NotoSansCJK');
    expect(data.font_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      (await backend.collect(attemptId, command, Date.now())).artifacts,
    ).toEqual(result.artifacts);
  }, 70000);

  it('checks XLSX numeric data using the fixed pandas/openpyxl runtime', async () => {
    const { result } = await run(
      `from openpyxl import Workbook\nimport pandas as pd\nw=Workbook();s=w.active;s.append(['项目','金额']);s.append(['科研中文名称',10]);s.append(['缺失',None]);s.append(['退款',-25]);w.save('/tmp/work/data.xlsx')\nd=pd.read_excel('/tmp/work/data.xlsx');v=pd.to_numeric(d['金额'],errors='raise');assert v.dropna().tolist()==[10,-25];assert v.isna().sum()==1;print(int(v.sum()))`,
    );
    expect(result.reason, result.output).toBe('completed');
    expect(result.output.trim()).toBe('-15');
  }, 30000);

  it('rejects fake PNG, CRC-valid broken zlib, truncation and oversized dimensions despite script exit zero', async () => {
    const mutations = [
      "raw=b'not a PNG'",
      'raw=raw[:len(raw)//2]',
      // Fixture mutations deliberately rebuild CRCs: Pillow must decode raster,
      // not accept only valid PNG headers or chunk checksums.
      `import struct,zlib\nat=8\nwhile at<len(raw):\n n=struct.unpack('>I',raw[at:at+4])[0]\n if raw[at+4:at+8]==b'IDAT':\n  payload=b'broken zlib stream'\n  raw=raw[:at]+struct.pack('>I',len(payload))+b'IDAT'+payload+struct.pack('>I',zlib.crc32(b'IDAT'+payload))+raw[at+n+12:]\n  break\n at+=n+12`,
      `import struct,zlib\nat=8\nwhile at<len(raw):\n n=struct.unpack('>I',raw[at:at+4])[0]\n if raw[at+4:at+8]==b'IDAT':\n  payload=raw[at+8:at+8+n][:5]\n  raw=raw[:at]+struct.pack('>I',len(payload))+b'IDAT'+payload+struct.pack('>I',zlib.crc32(b'IDAT'+payload))+raw[at+n+12:]\n  break\n at+=n+12`,
      `import struct,zlib\nraw=bytearray(raw);raw[16:20]=struct.pack('>I',9000);raw[29:33]=struct.pack('>I',zlib.crc32(raw[12:29]));raw=bytes(raw)`,
    ];
    for (const mutation of mutations) {
      const { result } = await run(
        `from PIL import Image\nimport io\nb=io.BytesIO();Image.new('RGB',(32,32),'white').save(b,format='PNG');raw=b.getvalue()\n${mutation}\nopen('output/chart.png','wb').write(raw)`,
        { outputs: [pngOutput] },
      );
      expect(result.reason, result.output).toBe('failed');
      expect(result.artifacts).toEqual([]);
      expect(result.output).toContain('png_check');
    }
  }, 90000);

  it('does not load tenant Pillow modules or return an image path as delivery bytes', async () => {
    const { result } = await run(
      `from PIL import Image\nImage.new('RGB',(2,2),'white').save('output/chart.png')\nimport os\nos.mkdir('PIL');open('PIL/__init__.py','w').write('raise RuntimeError("tenant_shadow_PIL")')\nprint('output/chart.png')`,
      { outputs: [pngOutput] },
    );
    expect(result.reason, result.output).toBe('completed');
    expect(result.artifacts[0]?.png).toMatchObject({
      checker: 'pillow-11.3.0',
      width: 2,
      height: 2,
    });
    expect(
      Buffer.from(result.artifacts[0]!.contentBase64, 'base64')
        .subarray(0, 8)
        .toString('hex'),
    ).toBe('89504e470d0a1a0a');
  }, 30000);

  it('keeps caches and input files private to each invocation and excludes host credentials/network', async () => {
    const first = await run(
      `open('/tmp/work/private-marker','w').write('private')\nprint('one')`,
    );
    expect(first.result.reason).toBe('completed');
    const { result } = await run(
      `import os,json,socket\ns=socket.socket();s.settimeout(0.5)\ntry:s.connect(('1.1.1.1',443));network=True\nexcept OSError:network=False\nprint(json.dumps({'previous':os.path.exists('/tmp/work/private-marker'),'home':os.environ['HOME'],'cache':os.environ['MPLCONFIGDIR'],'uid':os.getuid(),'network':network,'host':os.path.exists('/Users/a123')}))`,
    );
    expect(result.reason, result.output).toBe('completed');
    expect(JSON.parse(result.output)).toEqual({
      previous: false,
      home: '/tmp/work',
      cache: '/tmp/work/.mplconfig',
      uid: 65532,
      network: false,
      host: false,
    });
  }, 60000);

  it('enforces Python stdout/binary ceilings and deadline without publishing partial files', async () => {
    const stdout = await run("print('x'*2000)", {
      limits: { outputBytes: 1024 },
    });
    expect(stdout.result.reason).toBe('output_limit');
    expect(stdout.result.artifacts).toEqual([]);
    const binary = await run(
      "from PIL import Image\nimport os\nImage.frombytes('RGB',(100,100),os.urandom(30000)).save('output/chart.png')",
      { outputs: [pngOutput], limits: { artifactBytes: 1024 } },
    );
    // An incompressible multi-file output checks the aggregate bound separately.
    const aggregate = await run(
      "import os\nopen('output/a.txt','wb').write(os.urandom(800))\nopen('output/b.txt','wb').write(os.urandom(800))",
      {
        outputs: [
          { path: 'a.txt', fileName: 'a.txt', format: 'txt' },
          { path: 'b.txt', fileName: 'b.txt', format: 'txt' },
        ],
        limits: { artifactBytes: 1024 },
      },
    );
    expect(binary.result.reason, binary.result.output).toBe('failed');
    expect(binary.result.artifacts).toEqual([]);
    expect(aggregate.result.reason).toBe('failed');
    expect(aggregate.result.artifacts).toEqual([]);
    const deadline = await run('import time\ntime.sleep(10)', {
      limits: { timeoutMs: 1000 },
    });
    const state = await backend.json<{
      State: { FinishedAt: string };
      Config: { Labels: Record<string, string> };
    }>('GET', `/containers/allrice-cloud-${deadline.attemptId}/json`);
    expect(
      deadline.result.reason,
      JSON.stringify({
        result: deadline.result,
        deadline: state.Config.Labels['xyz.bplabs.allrice.cloud.deadline'],
        finishedAt: state.State.FinishedAt,
      }),
    ).toBe('deadline');
    expect(deadline.result.stopped).toBe(true);
    expect(deadline.result.artifacts).toEqual([]);
  }, 90000);

  it('cancels Python and its detached descendants through the existing physical lease lifecycle', async () => {
    const signal = new AbortController();
    const pending = run(
      "import subprocess,time\nsubprocess.Popen(['/opt/python/bin/python','-c','import time;time.sleep(60)'],start_new_session=True)\ntime.sleep(60)",
      {},
      [],
      signal.signal,
    );
    void pending.catch(() => undefined);
    try {
      await expect
        .poll(
          async () => (await backend.inspect(attempts[0]!))?.State.Running,
          { timeout: 20000 },
        )
        .toBe(true);
    } finally {
      signal.abort();
    }
    const { attemptId, result } = await pending;
    expect(result.reason).toBe('canceled');
    expect(result.stopped).toBe(true);
    expect(result.artifacts).toEqual([]);
    expect((await backend.inspect(attemptId))?.State.Running).toBe(false);
  }, 30000);

  it('embeds the same verified PNG bytes using the existing native Word/PPT libraries and Office checker', async () => {
    const { result } = await chart();
    expect(result.reason, result.output).toBe('completed');
    const png = Buffer.from(
      result.artifacts.find((a) => a.path === 'chart.png')!.contentBase64,
      'base64',
    );
    for (const [format, script] of Object.entries({
      docx: "from docx import Document\nfrom docx.shared import Inches\nd=Document();d.add_heading('中文费用图表',0);d.add_picture('input/chart.png',width=Inches(6));d.save('output/result.docx')",
      pptx: "from pptx import Presentation\nfrom pptx.util import Inches\np=Presentation();s=p.slides.add_slide(p.slide_layouts[5]);s.shapes.title.text='中文费用图表';s.shapes.add_picture('input/chart.png',Inches(1),Inches(1.5),width=Inches(8));p.save('output/result.pptx')",
    })) {
      const attemptId = randomUUID();
      attempts.push(attemptId);
      const office = await backend.executeOffice(
        CloudCommandInputSchema.parse({
          script,
          inputs: [
            {
              path: 'chart.png',
              objectId: randomUUID(),
              checksum: checksum(png),
            },
          ],
          outputs: [
            {
              path: `result.${format}`,
              fileName: `result.${format}`,
              format: 'txt',
            },
          ],
          limits: { timeoutMs: 60000, memoryMiB: 512, cpuMillis: 1000 },
        }),
        [{ path: 'chart.png', contentBase64: png.toString('base64') }],
        {
          attemptId,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          maintainLease: async () => true,
        },
      );
      expect(office.reason, office.output).toBe('completed');
      expect(office.output).toContain('"verdict": "pass"');
      const zip = await JSZip.loadAsync(
        Buffer.from(office.artifacts[0]!.contentBase64, 'base64'),
      );
      const embedded = Object.keys(zip.files).filter((path) =>
        /^(word|ppt)\/media\/.*\.png$/.test(path),
      );
      expect(embedded).toHaveLength(1);
      expect(await zip.file(embedded[0]!)!.async('nodebuffer')).toEqual(png);
    }
  }, 180000);
});
