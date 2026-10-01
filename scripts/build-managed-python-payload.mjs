#!/usr/bin/env node
/** Release operator: one pinned local image/archive. No VM lifecycle or registry writes. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { get } from 'node:http';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archiveLimit = 256 * 1024 ** 2;
const imageLimit = 512 * 1024 ** 2;
const pinnedSources = [
  'infra/docker/Dockerfile.office-python-local',
  'infra/managed-python/prepare-image.py',
  'infra/managed-python/licenses/Python-3.11.13.txt',
  'infra/managed-python/licenses/source.lock.json',
  'infra/managed-python/licenses/et-xmlfile-2.0.0-LICENSE',
  'infra/managed-python/licenses/openpyxl-3.1.5-LICENSE',
  'infra/python-charts/check_png.py',
  'infra/python-charts/prepare.py',
  'infra/python-charts/matplotlibrc',
  'skills/office/scripts/check_office.py',
  'skills/office/references/LICENSE.dsh',
];

export function parseRequirements(text) {
  const result = [];
  let current;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const requirement = /^([\w-]+)==([\w.+-]+)\s+\\$/.exec(line);
    if (requirement) {
      if (current && !current.sha256) throw Error('requirements_hash_missing');
      current = { name: requirement[1], version: requirement[2] };
      result.push(current);
    } else {
      const hash = /^--hash=sha256:([a-f0-9]{64})$/.exec(line);
      if (!current || current.sha256 || !hash)
        throw Error('requirements_not_exact_wheels');
      current.sha256 = hash[1];
    }
  }
  if (result.length !== 21 || result.some((r) => !r.sha256))
    throw Error('requirements_incomplete');
  if (new Set(result.map((r) => r.name.toLowerCase())).size !== result.length)
    throw Error('requirements_duplicate');
  return result;
}

export function verifyBytes(bytes, expected) {
  if (bytes.length !== expected.sizeBytes || sha(bytes) !== expected.sha256)
    throw Error('payload_input_changed');
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const item = await lstat(path);
  if (
    !item.isDirectory() ||
    item.isSymbolicLink() ||
    item.uid !== process.getuid()
  )
    throw Error('unsafe_payload_directory');
}

async function jsonMetadata(url) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw Error(`metadata_http_${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2_000_000) throw Error('metadata_limit');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  return JSON.parse(bytes.toString('utf8'));
}

async function cachedInput(input, cache) {
  const url = new URL(input.url);
  if (
    url.protocol !== 'https:' ||
    !['files.pythonhosted.org', 'deb.debian.org'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > 80_000_000
  )
    throw Error('unapproved_payload_input');
  const path = join(cache, input.sha256);
  if (await stat(path).catch(() => null)) {
    verifyBytes(await readFile(path), input);
    return path;
  }
  const response = await fetch(url, {
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body)
    throw Error(`input_download_http_${response.status}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      response.body,
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > input.sizeBytes)
            return callback(Error('payload_input_limit'));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    if (size !== input.sizeBytes || hash.digest('hex') !== input.sha256)
      throw Error('payload_input_changed');
    await rename(temporary, path);
    return path;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function command(args, { log, collect = false, timeoutMs } = {}) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let bytes = 0;
  const writer = log
    ? createWriteStream(log, { flags: 'wx', mode: 0o600 })
    : null;
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      writer?.write(chunk);
      if (collect) {
        bytes += chunk.length;
        if (bytes > 1_000_000) child.kill();
        else chunks.push(chunk);
      }
    });
  const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  if (timer) clearTimeout(timer);
  if (writer)
    await new Promise((resolveEnd, reject) => {
      writer.once('error', reject);
      writer.end(resolveEnd);
    });
  if (code !== 0 || bytes > 1_000_000)
    throw Error(`docker_command_failed_${code}`);
  return Buffer.concat(chunks).toString('utf8');
}

export function imageMeasurements(image, summary) {
  const sizes = [image.Size, summary.Size];
  if (sizes.some((size) => !Number.isSafeInteger(size) || size < 1))
    throw Error('payload_image_size_missing');
  const containerd = image.Descriptor !== undefined;
  const imageSizeBytes = containerd ? summary.Size - image.Size : image.Size;
  if (imageSizeBytes < 1 || summary.Id !== image.Id)
    throw Error('payload_image_size_changed');
  return {
    imageSizeBytes,
    imageContentSizeBytes: containerd ? image.Size : null,
    imageStorageSizeBytes: summary.Size,
    measurement: containerd
      ? 'containerd_total_storage_minus_compressed_content'
      : 'classic_uncompressed_inspect_size',
  };
}

async function imageSummary(socket, apiVersion, tag) {
  if (!/^1\.\d+$/.test(apiVersion)) throw Error('docker_api_version_missing');
  const filters = encodeURIComponent(JSON.stringify({ reference: [tag] }));
  const result = await new Promise((resolveResponse, reject) => {
    const request = get(
      {
        socketPath: socket.slice('unix://'.length),
        path: `/v${apiVersion}/images/json?filters=${filters}`,
        timeout: 30_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(Error('docker_image_summary_failed'));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1_000_000) request.destroy(Error('docker_metadata_limit'));
          else chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
        response.once('error', reject);
      },
    );
    request.once('timeout', () =>
      request.destroy(Error('docker_metadata_timeout')),
    );
    request.once('error', reject);
  });
  if (!Array.isArray(result) || result.length !== 1)
    throw Error('payload_image_summary_missing');
  return result[0];
}

async function saveArchive(prefix, imageId, path) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const child = spawn('docker', [...prefix, 'image', 'save', imageId], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolveExit() : reject(Error(`docker_save_failed_${code}`)),
    );
  });
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    await Promise.all([
      exited,
      pipeline(
        child.stdout,
        createGzip({ level: 9 }),
        new Transform({
          transform(chunk, _encoding, callback) {
            sizeBytes += chunk.length;
            if (sizeBytes > archiveLimit)
              return callback(Error('payload_archive_budget_exceeded'));
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      ),
    ]);
    await rename(temporary, path);
    return { sizeBytes, sha256: `sha256:${hash.digest('hex')}` };
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(temporary, { force: true });
  }
}

export async function buildPayload({ architecture, socket, output, repo }) {
  if (!['amd64', 'arm64'].includes(architecture))
    throw Error('unsupported_architecture');
  if (!/^unix:\/\/\/[^\0\n]+\.sock$/.test(socket))
    throw Error('explicit_unix_socket_required');
  output = resolve(output);
  repo = resolve(repo);
  await privateDirectory(output);
  const fileName = `managed-python-v1-${architecture}.tar.gz`;
  if (await stat(join(output, fileName)).catch(() => null))
    throw Error('payload_archive_already_exists');
  const prefix = ['--host', socket];
  const server = JSON.parse(
    await command([...prefix, 'version', '--format', '{{json .Server}}'], {
      collect: true,
    }),
  );
  const sourcePaths = [
    ...pinnedSources,
    `infra/managed-python/requirements-${architecture}.lock`,
    `infra/managed-python/apt-${architecture}.lock.json`,
    'scripts/build-managed-python-payload.mjs',
  ];
  const sources = [];
  const context = await mkdtemp(join(output, '.build-context-'));
  const cache = join(dirname(output), '.download-cache');
  await privateDirectory(cache);
  const startedAt = Date.now();
  try {
    for (const path of sourcePaths) {
      const bytes = await readFile(join(repo, path));
      sources.push({
        path,
        sizeBytes: bytes.length,
        sha256: `sha256:${sha(bytes)}`,
      });
      const target = join(context, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const aptBytes = await readFile(
      join(context, `infra/managed-python/apt-${architecture}.lock.json`),
    );
    const apt = JSON.parse(aptBytes.toString());
    if (apt.architecture !== architecture || apt.packages.length !== 1)
      throw Error('apt_platform_mismatch');
    const requirementsBytes = await readFile(
      join(context, `infra/managed-python/requirements-${architecture}.lock`),
    );
    const requirements = parseRequirements(requirementsBytes.toString());
    await mkdir(join(context, 'inputs/debs'), { recursive: true });
    await mkdir(join(context, 'inputs/wheels'), { recursive: true });
    await copyFile(
      join(context, `infra/managed-python/apt-${architecture}.lock.json`),
      join(context, 'inputs/apt.lock.json'),
    );
    await copyFile(
      join(context, `infra/managed-python/requirements-${architecture}.lock`),
      join(context, 'inputs/requirements.lock'),
    );
    const inputs = [];
    for (const input of apt.packages) {
      const cached = await cachedInput(input, cache);
      await copyFile(cached, join(context, 'inputs/debs', input.fileName));
      inputs.push({ ...input, independentlyVerified: true });
    }
    for (const requirement of requirements) {
      const source = `https://pypi.org/pypi/${requirement.name}/${requirement.version}/json`;
      const metadata = await jsonMetadata(source);
      const wheel = metadata.urls.find(
        (item) =>
          item.packagetype === 'bdist_wheel' &&
          !item.yanked &&
          item.digests.sha256 === requirement.sha256,
      );
      if (!wheel || !/^[\w.+-]+\.whl$/.test(wheel.filename))
        throw Error(`locked_wheel_missing_${requirement.name}`);
      const input = {
        ...requirement,
        fileName: wheel.filename,
        url: wheel.url,
        sizeBytes: wheel.size,
        source,
      };
      const cached = await cachedInput(input, cache);
      await copyFile(cached, join(context, 'inputs/wheels', input.fileName));
      inputs.push({ ...input, independentlyVerified: true });
    }
    console.log(
      `Downloaded and independently verified ${inputs.length} fixed inputs; building linux/${architecture} without build network.`,
    );
    const tag = `allrice-office-python:managed-v1-${architecture}`;
    const buildLog = join(output, `build-${Date.now()}.log`);
    await command(
      [
        ...prefix,
        'build',
        '--force-rm',
        '--network=none',
        '--platform',
        `linux/${architecture}`,
        '--build-arg',
        `PYTHON_RUNTIME_BASE=${apt.baseImage}`,
        '--file',
        join(context, 'infra/docker/Dockerfile.office-python-local'),
        '--tag',
        tag,
        context,
      ],
      { log: buildLog },
    );
    const [image] = JSON.parse(
      await command([...prefix, 'image', 'inspect', tag], { collect: true }),
    );
    const measurements = imageMeasurements(
      image,
      await imageSummary(socket, server.ApiVersion, tag),
    );
    if (
      image.Os !== 'linux' ||
      image.Architecture !== architecture ||
      measurements.imageSizeBytes > imageLimit
    )
      throw Error('payload_image_platform_or_budget_invalid');
    const buildOutput = await readFile(buildLog, 'utf8');
    const imageProof = buildOutput
      .split('\n')
      .filter((line) => line.includes('{"aptChecksum":'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{"aptChecksum":'))))
      .at(-1);
    if (
      !imageProof ||
      imageProof.packagesChecksum !== `sha256:${sha(requirementsBytes)}`
    )
      throw Error('payload_runtime_build_proof_missing');
    // One new, explicitly named release probe only. No existing container or VM is changed.
    const probeName = `allrice-managed-payload-probe-${randomUUID()}`;
    let runtimeProof;
    try {
      runtimeProof = JSON.parse(
        await command(
          [
            ...prefix,
            'run',
            '--name',
            probeName,
            '--rm',
            '--runtime',
            'runsc',
            '--network=none',
            '--read-only',
            '--memory=512m',
            '--memory-swap=512m',
            '--cpus=1',
            '--pids-limit=64',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
            '--env=OPENBLAS_NUM_THREADS=1',
            '--env=OMP_NUM_THREADS=1',
            '--env=HOME=/tmp',
            '--entrypoint=/opt/python/bin/python',
            image.Id,
            '-I',
            '/opt/allrice/probe.py',
            'probe',
          ],
          {
            collect: true,
            timeoutMs: 120_000,
            log: join(output, `probe-${Date.now()}.log`),
          },
        ),
      );
      if (JSON.stringify(runtimeProof) !== JSON.stringify(imageProof))
        throw Error('payload_runtime_proof_changed');
    } finally {
      await command([...prefix, 'container', 'rm', '--force', probeName]).catch(
        () => undefined,
      );
    }
    const archive = await saveArchive(prefix, image.Id, join(output, fileName));
    const proof = {
      contractVersion: 1,
      profileVersion: 1,
      architecture,
      nativeSupported: server.Arch === architecture,
      imageId: image.Id,
      ...measurements,
      pythonVersion: '3.11.13',
      archive: { fileName, ...archive },
      packagesChecksum: imageProof.packagesChecksum,
      officeChecker: imageProof.officeChecker,
      pngChecker: imageProof.pngChecker,
      font: imageProof.font,
      provenance: {
        serverArchitecture: server.Arch,
        serverVersion: server.Version,
        sources,
        inputs,
        buildLog,
        buildMilliseconds: Date.now() - startedAt,
        imageProof,
        runtimeProof,
        nativeBridgeColdStartVerified: false,
      },
    };
    await writeFile(
      join(output, 'source-proof.json'),
      JSON.stringify(proof, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        imageId: image.Id,
        ...measurements,
        archive: proof.archive,
        nativeBuild: proof.nativeSupported,
        sourceProof: join(output, 'source-proof.json'),
      }),
    );
    return proof;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== '--architecture' ||
    args[2] !== '--socket' ||
    args[4] !== '--output'
  )
    throw Error(
      'usage: --architecture amd64|arm64 --socket unix:///absolute/docker.sock --output /absolute/private/directory',
    );
  await buildPayload({
    architecture: args[1],
    socket: args[3],
    output: args[5],
    repo: resolve(dirname(new URL(import.meta.url).pathname), '..'),
  });
}
