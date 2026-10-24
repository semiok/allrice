import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseCompleteProcesses,
  parseNamespaceWriters,
  nativeProcesses,
  collectTerminalNativeAbsence,
  assertTerminalServiceIdle,
} from './terminal-native-physical-absence.mjs';
const hex = (b) => createHash('sha256').update(b).digest('hex');
const digest = (s) => 'sha256:' + hex(s);
const ps = (command = '/usr/bin/idle-fixture') =>
  `    121     1 Fri Oct 23 23:59:59 2026 ${command}\n`;
const artifact = digest('Synthetic artifact; no installed Native');
function authority() {
  const identities = ['web', 'worker'].map((service, i) => ({
    service,
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    manifestDigest: digest(service),
    environment: 'dev',
    bootId: 'synthetic-' + service,
    pid: 200 + i,
    startedAt: '2026-10-24T00:00:00.000Z',
  }));
  return {
    identities,
    healths: identities.map((identity) => ({
      identity,
      producerLifecycle: {
        role: identity.service,
        instance: { bootId: identity.bootId },
        releaseAdmission: 'disabled',
        unknownOutcomes: [],
        activeRoots: 0,
        pendingRoots: 0,
        retainedChildren: 0,
        unresolvedRoots: 0,
      },
    })),
  };
}
describe('terminal nonchat full process/writer evidence / injected read-only probes', () => {
  it('default operator is inert without any database or process inspection', () => {
    expect(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            new URL(
              './retire-terminal-native-test-contexts.mjs',
              import.meta.url,
            ).pathname,
          ],
          { env: { PATH: process.env.PATH }, encoding: 'utf8' },
        ),
      ),
    ).toMatchObject({ disabled: true, databaseWritten: false });
  });
  it('parses complete process identities and recognizes another root/wrapper too', () => {
    const rows = parseCompleteProcesses(
      ps('/elsewhere/node_modules/@lite-assistant/dsh/cli.js'),
    );
    expect(rows).toHaveLength(1);
    expect(nativeProcesses(rows, [])).toHaveLength(1);
  });
  it.each([
    '',
    '121 1 Fri Oct 23 23:59:59 2026 short',
    'malformed\n',
    ps() + ps(),
  ])(
    'refuses missing, truncated, malformed or duplicate process inventories (%#)',
    (raw) => {
      expect(() => parseCompleteProcesses(raw)).toThrow();
    },
  );
  it('does not treat an unspecified lsof access mode as read-only', () => {
    const raw = 'p121\0cworker\0\nf4\0n/scope/data\0\n';
    expect(parseNamespaceWriters(raw)).toHaveLength(1);
    expect(
      parseNamespaceWriters('p121\0cworker\0\nf4\0ar\0n/scope/data\0\n'),
    ).toEqual([]);
    expect(
      parseNamespaceWriters('p121\0cworker\0\nf4\0au\0n/scope/data\0\n'),
    ).toHaveLength(1);
  });
  it.each([
    'p121\0f4\0au',
    'pno-pid\0',
    'p121\0f4\0au\0',
    'p121\0f4\0ax\0n/a\0',
  ])('refuses incomplete or ambiguous writer evidence (%#)', (raw) => {
    expect(() => parseNamespaceWriters(raw)).toThrow();
  });
  it('requires both exact service births, disabled admission and no unknown outcomes', () => {
    const a = authority(),
      review = {
        serviceIdentities: a.identities,
        releaseSha: a.identities[0].sourceSha,
        sourceTree: a.identities[0].sourceTree,
      };
    assertTerminalServiceIdle(a.healths, review);
    for (const field of [
      'activeRoots',
      'retainedChildren',
      'pendingRoots',
      'unresolvedRoots',
    ]) {
      const changed = globalThis.structuredClone(a.healths);
      changed[1].producerLifecycle[field] = 1;
      expect(() => assertTerminalServiceIdle(changed, review)).toThrow();
    }
    const changed = globalThis.structuredClone(a.healths);
    changed[0].producerLifecycle.unknownOutcomes = ['unconfirmed'];
    expect(() => assertTerminalServiceIdle(changed, review)).toThrow();
  });
  it('collects both complete inventories and every exact writer range and persists raw evidence', async () => {
    const parent = resolve(
      import.meta.dirname,
      '../../..',
      '.tmp',
      'terminal-physical-fixtures',
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(parent + '/owned-');
    try {
      await mkdir(root + '/.local', { mode: 0o700 });
      await mkdir(root + '/runtime', { mode: 0o700 });
      const manifest = JSON.stringify({
        artifactId: artifact,
        content: { entrypoint: 'native/entry.mjs' },
      });
      await writeFile(root + '/.local/dsh-native-artifact.json', manifest, {
        mode: 0o600,
      });
      const a = authority(),
        scope = {
          artifactIds: [artifact],
          storageNamespaces: [
            root + '/runtime/old/a/sessions',
            root + '/runtime/old/b/sessions',
          ],
          digest: digest('Synthetic exact scopes'),
        };
      const review = {
        kind: 'allrice-dev-terminal-nonchat-retirement-review',
        rootReviewed: true,
        reviewedBy: 'root',
        requestId: '11111111-1111-4111-8111-111111111111',
        planDigest: digest('Synthetic plan'),
        releaseSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        operatorSha256: 'c'.repeat(64),
        serviceIdentities: a.identities,
        artifactRoots: [
          { artifactId: artifact, root, manifestSha256: hex(manifest) },
        ],
        runtimeStorageRoots: [
          { artifactId: artifact, root: root + '/runtime' },
        ],
      };
      const calls = [];
      const probe = async (file, args) => {
        calls.push([file, args]);
        return file === '/bin/ps' ? ps() : '';
      };
      const input = {
        scope,
        review,
        requestId: review.requestId,
        planDigest: review.planDigest,
        reviewSha256: 'd'.repeat(64),
        readHealths: async () => globalThis.structuredClone(a.healths),
        probe,
        evidencePath: root + '/evidence.json',
        saveEvidence: async (path, value) =>
          writeFile(path, JSON.stringify(value, null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
          }),
      };
      const proof = await collectTerminalNativeAbsence(input);
      expect(proof.nativeProcesses).toEqual([]);
      expect(proof.writers).toEqual([]);
      expect(proof.evidenceSha256).toBe(
        hex(await readFile(input.evidencePath)),
      );
      expect(calls.map((c) => c[0])).toEqual([
        '/bin/ps',
        '/usr/sbin/lsof',
        '/usr/sbin/lsof',
        '/bin/ps',
      ]);
      expect(calls[1][1]).toEqual(['-nP', '-F0pcfan', '+D', root + '/runtime']);
      expect(calls[2][1]).toEqual(['-nP', '-F0pcfan', '+L1']);
      expect(
        JSON.parse(await readFile(input.evidencePath, 'utf8')).beforeRaw,
      ).toBe(ps());
      for (const command of [
        root + '/native/entry.mjs',
        '/another/allrice-jsonrpc-runtime.mjs',
      ])
        await expect(
          collectTerminalNativeAbsence({
            ...input,
            probe: async () => ps(command),
          }),
        ).rejects.toThrow(/PROCESS_ACTIVE/);
      await expect(
        collectTerminalNativeAbsence({
          ...input,
          probe: async (file) =>
            file === '/bin/ps'
              ? ps()
              : 'p121\0cunknown\0\nf4\0au\0n' +
                root +
                '/runtime/old/a/data\0\n',
        }),
      ).rejects.toThrow(/WRITER_ACTIVE/);
      await expect(
        collectTerminalNativeAbsence({
          ...input,
          probe: async (file, args) =>
            file === '/bin/ps'
              ? ps()
              : args.includes('+L1')
                ? 'p121\0cunknown-writer\0\nf4\0au\0n' +
                  root +
                  '/runtime/removed/deleted.txt (deleted)\0\n'
                : '',
        }),
      ).rejects.toThrow(/WRITER_ACTIVE/);
      await expect(
        collectTerminalNativeAbsence({
          ...input,
          scope: { ...scope, storageNamespaces: ['/uncovered/other-history'] },
        }),
      ).rejects.toThrow(/NAMESPACE_UNCOVERED/);
      await expect(
        collectTerminalNativeAbsence({
          ...input,
          review: { ...review, artifactRoots: [] },
        }),
      ).rejects.toThrow(/ARTIFACT_SCOPE_CHANGED/);
      await expect(
        collectTerminalNativeAbsence({
          ...input,
          probe: async () => {
            throw Error('synthetic permission/timeout failure');
          },
        }),
      ).rejects.toThrow('synthetic permission/timeout failure');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  });
});
