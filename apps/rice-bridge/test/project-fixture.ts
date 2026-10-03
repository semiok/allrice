import { createHash, randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
  managedPythonPayloadForPlatform,
} from '@allrice/contracts';
import { dependencyFixture } from './dependency-fixture.js';
import { projectSourceDigest } from '../src/project-preparation.js';
const sha = (b: Buffer | string) =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** One self-authored frontend package and one pure-Python wheel. Same inputs are
 * reused for native install/cache/cancel and later workspace acceptance.
 */
export function projectFixture(
  manager: 'pnpm' | 'uv',
  architecture: 'amd64' | 'arm64' = 'amd64',
) {
  let files: Record<string, Buffer>, packages: unknown[];
  if (manager === 'pnpm') {
    const f = dependencyFixture();
    files = {
      'package.json': Buffer.from(
        JSON.stringify({ ...f.manifest, packageManager: 'pnpm@10.33.3' }),
      ),
      'pnpm-lock.yaml': Buffer.from(
        `lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .:\n    dependencies:\n      ${f.pkg.name}:\n        specifier: ${f.pkg.version}\n        version: ${f.pkg.version}\npackages:\n  ${f.pkg.name}@${f.pkg.version}:\n    resolution: {integrity: ${f.pkg.integrity}}\nsnapshots:\n  ${f.pkg.name}@${f.pkg.version}: {}\n`,
      ),
      'package.tgz': f.files['package.tgz']!,
      'verify.cjs': f.files['verify.cjs']!,
    };
    packages = [f.pkg];
  } else {
    const name = 'allrice_fixture_py',
      version = '1.0.0',
      dist = `${name}-${version}.dist-info`;
    const entries: Record<string, Uint8Array> = {
      [`${name}/__init__.py`]: Buffer.from('def add(a,b):\n    return a+b\n'),
      [dist + '/METADATA']: Buffer.from(
        'Metadata-Version: 2.1\nName: ' + name + '\nVersion: ' + version + '\n',
      ),
      [dist + '/WHEEL']: Buffer.from(
        'Wheel-Version: 1.0\nGenerator: allrice-native-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
      ),
      [dist + '/RECORD']: Buffer.from(
        `${name}/__init__.py,,\n${dist}/METADATA,,\n${dist}/WHEEL,,\n${dist}/RECORD,,\n`,
      ),
    };
    const bytes = Buffer.from(zipSync(entries)),
      fileName = `${name}-${version}-py3-none-any.whl`,
      checksum = sha(bytes);
    files = {
      'requirements.lock': Buffer.from(
        `${name}==${version} --hash=${checksum}\n`,
      ),
      [fileName]: bytes,
      'verify.py': Buffer.from(
        `from ${name} import add\nassert add(20,22)==42\nprint('dependency verification: 42')\n`,
      ),
    };
    packages = [
      {
        name,
        version,
        fileName,
        url: `https://files.pythonhosted.org/packages/allrice-fixture/${fileName}`,
        sha256: checksum,
        archivePath: fileName,
      },
    ];
  }
  const manifest = Object.entries(files).map(([path, bytes]) => ({
    path,
    sha256: sha(bytes),
  }));
  const lockPath = manager === 'pnpm' ? 'pnpm-lock.yaml' : 'requirements.lock';
  const command = RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable:
        manager === 'pnpm'
          ? '/usr/local/bin/node'
          : '/workspace/.venv/bin/python',
      args: [manager === 'pnpm' ? 'verify.cjs' : 'verify.py'],
      path: '.',
      files: manifest,
      projectPreparation: {
        version: 1,
        projectId: randomUUID(),
        sourceDigest: projectSourceDigest(manifest),
        lockChecksum: sha(files[lockPath]!),
        manager,
        managerVersion: manager === 'pnpm' ? '10.33.3' : '0.8.22',
        lockPath,
        offline: false,
        scripts: 'disabled',
        packages,
      },
      imageDigest:
        manager === 'pnpm'
          ? localCommandToolchainImageV1
          : managedPythonPayloadForPlatform(
              architecture === 'amd64' ? 'macos-x64' : 'macos-arm64',
            )!.imageId,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 60000,
        outputBytes: 16384,
        memoryMiB: 512,
        cpuMillis: 1000,
        pids: 64,
      },
    },
  });
  return {
    files,
    command,
    bundle: Object.entries(files).map(([path, bytes]) => ({
      path,
      content: bytes.toString('base64'),
    })),
  };
}
