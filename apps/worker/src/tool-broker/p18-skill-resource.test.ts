import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@allrice/contracts';
import { skillBundleChecksum, skillBytesChecksum } from '@allrice/database';
import {
  nativeGovernedToolNames,
  riceReadOnlyToolDefinitionsForPreview,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
} from './definitions.js';
import { readSkillResource } from './handlers/skill.js';
import { riceToolHandlerRegistry } from './registry.js';

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
const granted = ['workspace.skill.read'];

function fixture() {
  const actorId = randomUUID(),
    organizationId = randomUUID();
  const context: ExecutionContext = {
    executionId: randomUUID(),
    runId: randomUUID(),
    jobId: randomUUID(),
    worker: { type: 'worker', id: randomUUID() },
    delegatedBy: { type: 'user', id: actorId },
    organizationId,
    workspaceId: randomUUID(),
    policySnapshot: {
      id: randomUUID(),
      organizationId,
      subjectId: actorId,
      version: 1,
      issuedAt: '2026-09-08T00:00:00.000Z',
      expiresAt: '2026-09-09T00:00:00.000Z',
      memberships: [],
      grants: [],
    },
    startedAt: '2026-09-08T00:00:00.000Z',
  };
  const content = '# Synthetic resource Skill\n';
  const script = 'throw Error("never execute during resource read");\n';
  const payload = {
    schemaVersion: 1 as const,
    version: '1.0.0',
    contentChecksum: skillBytesChecksum(content),
    sourceRef: 'https://example.test/reviewed',
    license: 'Apache-2.0',
    reviewedBy: 'synthetic',
    resources: [
      {
        path: 'scripts/inert.mjs',
        mediaType: 'text/javascript',
        byteLength: Buffer.byteLength(script),
        checksum: skillBytesChecksum(script),
        contentBase64: Buffer.from(script).toString('base64'),
      },
    ],
    dependencies: [{ kind: 'tool' as const, name: 'workspace.skill.read' }],
  };
  const bundle = { ...payload, checksum: skillBundleChecksum(payload) };
  const skill = {
    id: randomUUID(),
    name: 'synthetic-resource',
    description: 'Test only',
    content,
    checksum: skillBytesChecksum(content),
    invocation: { modelInvocable: true, userInvocable: true },
    requiredToolRefs: granted,
    bundle,
  };
  const args = { skill: skill.name, path: 'scripts/inert.mjs' };
  return {
    script,
    skill,
    args,
    input: {
      context,
      capabilities: ['storage:read'] as ['storage:read'],
      storageRoot: '/unused/no-host-read',
      nativeSkills: [skill],
      call: { id: randomUUID(), name: 'workspace.skill.read', arguments: args },
    },
  };
}

describe('P18 immutable Skill resource reader', () => {
  it('is read-only, requires storage read and respects frozen tool allowlists', () => {
    expect(
      names(riceToolDefinitionsForCapabilities([], granted)),
    ).not.toContain('workspace.skill.read');
    expect(
      names(riceToolDefinitionsForCapabilities(['storage:read'], [])),
    ).not.toContain('workspace.skill.read');
    expect(
      names(riceToolDefinitionsForTurn(['storage:read'], granted, [])),
    ).toEqual(granted);
    expect(
      names(riceReadOnlyToolDefinitionsForPreview(['storage:read'], granted)),
    ).toEqual(granted);
    expect(riceToolHandlerRegistry['workspace.skill.read'].category).toBe(
      'workspace',
    );
    expect([...nativeGovernedToolNames]).toEqual([
      'cloud.process.execute',
      'cloud.mcp.call',
      'local.mcp.discover',
      'local.mcp.call',
    ]);
  });
  it('returns exact frozen script bytes as inert data, with no execution authority', async () => {
    const f = fixture();
    const result = await readSkillResource({
      input: f.input,
      arguments: f.args,
    });
    expect(JSON.parse(result.modelContent)).toMatchObject({
      version: '1.0.0',
      text: f.script,
      executionPermission: false,
    });
    expect(result.summary).toContain('未执行');
  });
  it('cannot read a missing frozen resource, another Skill or a host path', async () => {
    const f = fixture();
    await expect(
      readSkillResource({
        input: { ...f.input, nativeSkills: [] },
        arguments: f.args,
      }),
    ).rejects.toThrow('frozen_run');
    await expect(
      readSkillResource({
        input: f.input,
        arguments: { ...f.args, skill: 'unbound' },
      }),
    ).rejects.toThrow('frozen_run');
    await expect(
      readSkillResource({
        input: f.input,
        arguments: { ...f.args, path: '../secrets' },
      }),
    ).rejects.toThrow();
    await expect(
      readSkillResource({
        input: f.input,
        arguments: { ...f.args, path: '/etc/passwd' },
      }),
    ).rejects.toThrow();
  });
  it('rejects tampered resource bytes instead of falling back to mutable files', async () => {
    const f = fixture();
    f.skill.bundle.resources[0]!.contentBase64 =
      Buffer.from('changed').toString('base64');
    await expect(
      readSkillResource({ input: f.input, arguments: f.args }),
    ).rejects.toThrow('checksum');
  });
});
