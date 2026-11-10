import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MemoryOrdinalInputSchema,
  RunMemoryContextV2StateSchema,
  hasMemoryIndexReadTool,
  memoryIndexPolicy,
  renderMemoryDetailV2,
  renderMemoryIndexV2,
} from './memory-index.ts';
import { EmployeeDocumentsSchema } from './employee-documents.ts';
import { EmployeePromptSnapshotSchema } from './employees.ts';
import {
  freezeMemoryIndexToolNames,
  memoryContextPolicy,
} from './memory-context.ts';

describe('v2 complete memory text and immutable version contracts', () => {
  it('carries all 100 summaries including ordinal100, at the structural byte bound', () => {
    const summary = '🧑'.repeat(40);
    const text = renderMemoryIndexV2(
      Array.from({ length: 100 }, () => ({ summary, hasDetails: true })),
    );
    expect(Buffer.byteLength(text)).toBe(18303);
    expect(text).toContain(`[100] ${summary}（有说明）`);
    expect(
      text.split('\n').filter((line) => line.startsWith('[')),
    ).toHaveLength(100);
    expect(renderMemoryIndexV2([])).toBe('');
    expect(() =>
      renderMemoryIndexV2(
        Array.from({ length: 101 }, () => ({ summary, hasDetails: false })),
      ),
    ).toThrow();
    expect(
      EmployeeDocumentsSchema.parse({
        schemaVersion: 2,
        user: '',
        memory: text,
      }).memory,
    ).toBe(text);
    expect(
      EmployeeDocumentsSchema.safeParse({ user: '', memory: text }).success,
    ).toBe(false);
    expect(
      EmployeeDocumentsSchema.safeParse({
        schemaVersion: 2,
        user: '',
        memory: 'x'.repeat(18304),
      }).success,
    ).toBe(false);
  });

  it('refuses the old full-memory side channel in an explicit v2 prompt', () => {
    const prompt = {
      systemPrompt: 'Employee policy',
      conversation: [],
      memories: [{ id: randomUUID(), content: 'must not be copied' }],
      userRequest: 'Task',
      employeeDocuments: { schemaVersion: 2, user: '', memory: '' },
    };
    expect(EmployeePromptSnapshotSchema.safeParse(prompt).success).toBe(false);
    expect(
      EmployeePromptSnapshotSchema.safeParse({ ...prompt, memories: [] })
        .success,
    ).toBe(true);
    expect(
      EmployeePromptSnapshotSchema.safeParse({
        ...prompt,
        employeeDocuments: { user: '', memory: '' },
      }).success,
    ).toBe(true);
  });

  it.each(['🧑', '中', '\u0001', '"', '\\', '\n'])(
    'returns full details as decoded text through a JSON wire roundtrip: %j',
    (character) => {
      // Keep nonblank text while exercising escaping at the end of the detail.
      const details = '始' + character.repeat(1998) + '末';
      const summary = '🧑'.repeat(40);
      const output = renderMemoryDetailV2(100, { summary, details });
      expect(output).toBe(
        `MEMORY_DETAIL_V2\nnumber=100\nsummary:\n${summary}\ndetails:\n${details}\nEND_MEMORY_DETAIL_V2`,
      );
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8228);
      expect(JSON.parse(JSON.stringify({ content: output })).content).toBe(
        output,
      );
      expect(output).not.toContain('"details":');
      if (character === '🧑') expect(Buffer.byteLength(output)).toBe(8226);
      if (character === '\u0001')
        expect(
          Buffer.byteLength(JSON.stringify({ content: output })),
        ).toBeGreaterThan(10000);
    },
  );

  it('keeps the legacy policy and accepts a short read even with less than512 remaining', () => {
    expect(memoryContextPolicy).toEqual({
      version: 1,
      meter: 'utf8_bytes',
      maximumInitialBytes: 6000,
      maximumResponseBytes: 8000,
      maximumRunBytes: 24000,
      maximumToolReads: 12,
    });
    expect(
      Buffer.byteLength(
        renderMemoryDetailV2(1, { summary: '短', details: null }),
      ),
    ).toBeLessThan(512);
    expect(24000 - memoryIndexPolicy.maximumInitialBytes).toBe(5697);
    expect(
      Buffer.byteLength(
        renderMemoryDetailV2(100, {
          summary: '🧑'.repeat(40),
          details: '🧑'.repeat(2000),
        }),
      ),
    ).toBe(8228);
  });

  it('requires continuous unique server pins and exact frozen limits', () => {
    const pin = {
      number: 1,
      id: randomUUID(),
      revision: 1,
      pairDigest: `sha256:${'a'.repeat(64)}`,
      hasDetails: true,
    };
    const state = {
      schemaVersion: 2,
      meter: 'utf8_bytes',
      limits: memoryIndexPolicy,
      initial: {
        digest: pin.pairDigest,
        documentDigest: pin.pairDigest,
        bytes: 100,
      },
      pins: [pin],
      spentBytes: 100,
      toolReads: 0,
    };
    expect(RunMemoryContextV2StateSchema.safeParse(state).success).toBe(true);
    for (const bad of [
      { ...state, pins: [pin, pin] },
      { ...state, pins: [{ ...pin, number: 2 }] },
      { ...state, spentBytes: 99 },
      { ...state, toolReads: 13 },
      { ...state, limits: { ...memoryIndexPolicy, maximumRunBytes: 50000 } },
      { ...state, pins: [{ ...pin, details: 'must not be copied' }] },
    ])
      expect(RunMemoryContextV2StateSchema.safeParse(bad).success).toBe(false);
    for (const input of [
      { number: 0 },
      { number: 101 },
      { number: '1' },
      { number: 1.5 },
      { number: 1, id: pin.id },
    ])
      expect(MemoryOrdinalInputSchema.safeParse(input).success).toBe(false);
  });

  it('replaces old read names only when a memory grant exists, without changing the caller', () => {
    const tools = [
      'workspace.file.read',
      'workspace.memory.search',
      'workspace.experience.read',
    ];
    expect(
      freezeMemoryIndexToolNames(tools, ['storage:read'], undefined),
    ).toEqual(['workspace.file.read', 'workspace.memory.read']);
    expect(tools).toContain('workspace.memory.search');
    expect(
      freezeMemoryIndexToolNames(
        ['workspace.file.read'],
        ['storage:read'],
        undefined,
      ),
    ).not.toContain('workspace.memory.read');
    expect(freezeMemoryIndexToolNames(tools, [], undefined)).not.toContain(
      'workspace.memory.read',
    );
    expect(
      hasMemoryIndexReadTool({
        capabilitySnapshot: {
          grantedCapabilities: ['storage:read'],
          bindings: { toolNames: ['workspace.file.read'] },
        },
      }),
    ).toBe(false);
    expect(
      hasMemoryIndexReadTool({
        capabilitySnapshot: {
          grantedCapabilities: ['storage:read'],
          bindings: { toolNames: ['workspace.memory.read'] },
        },
      }),
    ).toBe(true);
    const full = Array.from({ length: 64 }, (_, i) =>
      i ? `tool${i}` : 'workspace.memory.search',
    );
    expect(
      freezeMemoryIndexToolNames(full, ['storage:read'], undefined),
    ).toHaveLength(64);
    expect(() =>
      freezeMemoryIndexToolNames(
        [...full, 'another'],
        ['storage:read'],
        undefined,
      ),
    ).toThrow();
    const model = {
      harness: 'dsh',
      provider: 'openai-codex',
      authMode: 'chatgpt_subscription',
      platformSettings: { configuration: { imagesEnabled: true } },
    } as NonNullable<Parameters<typeof freezeMemoryIndexToolNames>[2]>;
    const grants = ['storage:read', 'storage:write', 'model:invoke'] as const;
    const imageTools = [
      'workspace.memory.search',
      'workspace.export.create',
      ...Array.from({ length: 60 }, (_, i) => `synthetic_${i}`),
    ];
    expect(freezeMemoryIndexToolNames(imageTools, grants, model)).toHaveLength(
      62,
    );
    expect(() =>
      freezeMemoryIndexToolNames([...imageTools, 'one_more'], grants, model),
    ).toThrow();
  });
});
