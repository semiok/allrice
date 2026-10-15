import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import {
  ProjectDependencyResolveInputSchema,
  ProjectDependencyResolutionReceiptSchema,
  RuntimeProjectPreparationSchema,
  RuntimeNpmPackageSchema,
  projectResolutionLimits,
  projectResolutionManifest,
  type ProjectDependencyResolveInput,
  type RuntimeProjectPreparation,
  cloudPythonImageV1,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { RuntimeCommandError } from './errors.js';
import { validateProjectPreparation } from './project-preparation.js';

function fail(): never {
  throw new RuntimeCommandError('PROJECT_RESOLUTION_LOCK_UNSUPPORTED');
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: string) =>
  'sha256:' + createHash('sha256').update(v).digest('hex');

/** Treat package-manager output as untrusted data. This only builds input for
 * the existing independent lock/SRI validation and isolated installer. */
export function readResolvedProject(
  input: ProjectDependencyResolveInput,
  bytes: Buffer,
) {
  const args = ProjectDependencyResolveInputSchema.parse(input);
  if (bytes.length > projectResolutionLimits.receiptBytes) fail();
  const receipt = ProjectDependencyResolutionReceiptSchema.parse(
    JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
  );
  if (receipt.manager !== args.manager) fail();
  if (receipt.status === 'failed') return { receipt };
  const lock = receipt.lock!;
  if (Buffer.byteLength(lock) > projectResolutionLimits.lockBytes) fail();
  const manifest = projectResolutionManifest(args);
  let preparation: Omit<
    RuntimeProjectPreparation,
    'projectId' | 'sourceDigest' | 'lockChecksum'
  >;
  if (args.manager === 'pnpm') {
    if (receipt.wheels) fail();
    const doc = parseDocument(lock, { uniqueKeys: true });
    if (doc.errors.length) fail();
    let data: unknown;
    try {
      data = doc.toJS({ maxAliasCount: 0 });
    } catch {
      fail();
    }
    if (
      !object(data) ||
      String(data.lockfileVersion) !== '9.0' ||
      !object(data.packages) ||
      !object(data.importers) ||
      Object.keys(data.importers).length !== 1 ||
      !object(data.importers['.']) ||
      data.patchedDependencies ||
      data.overrides ||
      data.catalogs
    )
      fail();
    const importer = data.importers['.'];
    if (
      !object(importer.dependencies) ||
      importer.devDependencies ||
      importer.optionalDependencies ||
      Object.keys(importer.dependencies).length !== args.packages.length
    )
      fail();
    const packages = Object.entries(data.packages).map(([key, value]) => {
      const split = key.lastIndexOf('@');
      if (
        split <= 0 ||
        !object(value) ||
        !object(value.resolution) ||
        Object.keys(value.resolution).length !== 1
      )
        fail();
      return RuntimeNpmPackageSchema.parse({
        name: key.slice(0, split),
        version: key.slice(split + 1),
        integrity: value.resolution.integrity,
      });
    });
    if (
      packages.length >
        (args.resourceProfile === 'web-development'
          ? projectResolutionLimits.webPackageCount
          : projectResolutionLimits.packageCount) ||
      !packages.length
    )
      throw new RuntimeCommandError('PROJECT_RESOLUTION_LIMIT');
    for (const pkg of args.packages) {
      const v = importer.dependencies[pkg.name];
      if (
        !object(v) ||
        v.specifier !== pkg.version ||
        typeof v.version !== 'string' ||
        !(
          v.version === pkg.version || v.version.startsWith(pkg.version + '(')
        ) ||
        !packages.some((p) => p.name === pkg.name && p.version === pkg.version)
      )
        fail();
    }
    preparation = {
      version: 1,
      manager: 'pnpm',
      managerVersion: '10.33.3',
      offline: false,
      lockPath: 'pnpm-lock.yaml',
      scripts: 'disabled',
      packages,
      ...(args.resourceProfile === 'web-development'
        ? { resourceProfile: 'web-development' as const }
        : {}),
    };
  } else {
    if (!receipt.wheels?.length) fail();
    const normalize = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');
    const wheels = receipt.wheels;
    if (new Set(wheels.map((p) => normalize(p.name))).size !== wheels.length)
      fail();
    for (const pkg of args.packages)
      if (
        !wheels.some(
          (p) =>
            normalize(p.name) === normalize(pkg.name) &&
            p.version === pkg.version,
        )
      )
        fail();
    preparation = {
      version: 1,
      manager: 'uv',
      managerVersion: '0.8.22',
      offline: false,
      lockPath: 'requirements.lock',
      scripts: 'disabled',
      packages: wheels,
    };
  }
  const files = [manifest, { path: preparation.lockPath, text: lock }].sort(
    (a, b) => a.path.localeCompare(b.path),
  );
  const sourceDigest = sha(
    JSON.stringify(files.map((f) => ({ path: f.path, sha256: sha(f.text) }))),
  );
  const forProject = (projectId: string) =>
    RuntimeProjectPreparationSchema.parse({
      ...preparation,
      projectId,
      sourceDigest,
      lockChecksum: sha(lock),
    });
  // The package manager is not our authority for the lock format. Exercise the
  // same independent validator used by both installers before saving a project.
  validateProjectPreparation(
    {
      arguments: {
        executable:
          args.manager === 'pnpm'
            ? '/usr/local/bin/node'
            : '/workspace/.venv/bin/python',
        args: [],
        path: '.',
        files: files.map((f) => ({ path: f.path, sha256: sha(f.text) })),
        imageDigest:
          args.manager === 'pnpm' ? cloudToolchainImageV1 : cloudPythonImageV1,
        limits: {
          timeoutMs: 60000,
          outputBytes: 16384,
          memoryMiB: 512,
          cpuMillis: 1000,
          pids: 64,
        },
        projectPreparation: forProject('00000000-0000-4000-8000-000000000001'),
      },
    },
    files.map((f) => ({
      path: f.path,
      content: Buffer.from(f.text).toString('base64'),
    })),
  );
  return { receipt, files, sourceDigest, forProject };
}
