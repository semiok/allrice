import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { runtimeNpmPackageUrl } from '@allrice/contracts';

/** Tiny self-authored npm package; no global npm install or downloaded fixture. */
export function dependencyFixture(installScript?: string) {
  const entries: Record<string, string> = {
    'package/package.json': JSON.stringify({
      name: 'allrice-p09b-fixture',
      version: '1.0.0',
      main: 'index.js',
      ...(installScript ? { scripts: { postinstall: installScript } } : {}),
    }),
    'package/index.js': 'module.exports = (a,b) => a + b;',
  };
  const records: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const bytes = Buffer.from(content),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0001750\0', 108);
    header.write('0001750\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const checksum = header.reduce((a, b) => a + b, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    records.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  const archive = gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
  const pkg = {
    name: 'allrice-p09b-fixture',
    version: '1.0.0',
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    archivePath: 'package.tgz',
  };
  const manifest = {
    name: 'p09b-project',
    version: '1.0.0',
    dependencies: { [pkg.name]: pkg.version },
  };
  const lock = {
    name: manifest.name,
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': manifest,
      [`node_modules/${pkg.name}`]: {
        version: pkg.version,
        resolved: runtimeNpmPackageUrl(pkg),
        integrity: pkg.integrity,
        ...(installScript ? { hasInstallScript: true } : {}),
      },
    },
  };
  const files: Record<string, Buffer> = {
    'package.json': Buffer.from(JSON.stringify(manifest)),
    'package-lock.json': Buffer.from(JSON.stringify(lock)),
    'package.tgz': archive,
    'verify.cjs': Buffer.from(
      `const add=require('${pkg.name}');if(add(20,22)!==42)throw Error('incorrect');console.log('dependency verification: 42');`,
    ),
  };
  return { pkg, files, lock, manifest };
}
