import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);
type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const readManifest = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Manifest;
const workspaces = new Map<string, string>();
// These are the two workspace directories declared in pnpm-workspace.yaml.
for (const directory of ['apps', 'packages']) {
  for (const entry of readdirSync(new URL(`${directory}/`, root), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}/package.json`;
    if (entry.isDirectory() && existsSync(new URL(path, root)))
      workspaces.set(readManifest(path).name, path);
  }
}

function installationManifests(dockerfile: string) {
  const source = readFileSync(new URL(dockerfile, root), 'utf8');
  const install = source.indexOf('RUN pnpm install --frozen-lockfile');
  if (install < 0) throw Error(`${dockerfile}: missing frozen install layer`);
  return new Set(
    [
      ...source
        .slice(0, install)
        .matchAll(/^COPY ((?:apps|packages)\/[^/\s]+\/package\.json) \1\s*$/gm),
    ].map((match) => match[1]!),
  );
}

for (const app of ['web', 'worker']) {
  const dockerfile = `infra/docker/Dockerfile.${app}`;
  describe(dockerfile, () => {
    it('includes the browser workspace before dependency installation', () => {
      const copied = installationManifests(dockerfile);
      expect(copied).toContain(`apps/${app}/package.json`);
      expect(copied).toContain('packages/browser-control/package.json');
    });

    it('includes every local dependency of the copied workspace manifests', () => {
      const copied = installationManifests(dockerfile);
      for (const path of copied) {
        const manifest = readManifest(path);
        const dependencies = {
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        };
        for (const [name, version] of Object.entries(dependencies)) {
          if (!version.startsWith('workspace:')) continue;
          const required = workspaces.get(name);
          expect(required, `${path}: unknown workspace ${name}`).toBeDefined();
          expect(
            copied.has(required!),
            `${dockerfile}: COPY ${required} before pnpm install (${path} depends on ${name})`,
          ).toBe(true);
        }
      }
    });
  });
}
