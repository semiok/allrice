import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { platformRepositoryReviewInstructions } from '@allrice/database';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { assembleEmployeeKernel } from './employee-kernel.js';
import { dshHostCapabilityInstructions } from './harness/dsh/tool-bridge.js';
import { riceToolDefinitions } from './tool-broker.js';

// MET-214, user 10-27: the desktop app is 「AllRice 助手」; delegated children
// are 「子智能体」 as in DSH web (设置 → 插件 → 子智能体). The model repeats the
// names it reads (a real run said "请检查 Rice Bridge 连接", "两位助手"), so the
// text it reads must not carry the old ones.
const oldNames = [
  /Rice Bridge|子助手|子助理|父助手|父智能体/,
  /(?<![A-Za-z_.$])Bridge(?![A-Za-z_])/,
  // 「技术助手」 is the platform technical assistant's own name.
  /(?<!AllRice )(?<!技术)助手/,
];
// Tool identifiers such as assistant.report / assistant_delegate and event
// names such as assistant/message retain their protocol spelling.
const englishChild = /(?<![\w./-])assistants?(?![\w./-])/i;
// allrice-bootstrap-coverage hashes the chat role and keys coverage by message
// ID. Match whole literal values; "Assistant stopped" is never a protocol value.
const protocolValues: Record<string, readonly string[]> = {
  'allrice-bootstrap-coverage.mjs': ['assistant', 'assistant:'],
};
// These memory provenance rules refer to the model's own output, not delegated
// children. Exempt only these phrases in their documented source files.
const modelRoleTerms: Record<string, readonly string[]> = {
  'skills/governed-memory/SKILL.md': [
    'assistant response',
    'assistant guesses',
  ],
  'allrice-jsonrpc-implementation.mjs': ['assistant inference'],
};

interface SourcedText {
  source: string;
  text: string;
}

const dsh = resolve(import.meta.dirname, '../dsh');
const harness = resolve(import.meta.dirname, 'harness/dsh');
const repository = resolve(import.meta.dirname, '../../..');

/** String literals and template text, never comments or identifiers. */
function literals(file: string, source: string, only?: 'messages') {
  const out: string[] = [];
  const text = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      out.push(node.text);
    else if (ts.isTemplateExpression(node))
      out.push(
        node.head.text,
        ...node.templateSpans.map((s) => s.literal.text),
      );
    ts.forEachChild(node, text);
  };
  const visit = (node: ts.Node): void => {
    if (!only) return text(node);
    // What a governed tool returns to the model: {message} and HandlerError text.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === 'message' || node.name.text === 'summary')
    )
      text(node.initializer);
    else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'HandlerError'
    )
      node.arguments?.slice(1, 2).forEach(text);
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  );
  return out.map((text) => ({ source: file, text }));
}

async function sources(dir: string, match: (name: string) => boolean) {
  const names = (await readdir(dir)).filter(
    (name) => match(name) && !name.includes('.test.'),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(join(dir, name), 'utf8'),
    })),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(strings);
  return [];
}

async function markdown(dir: string): Promise<SourcedText[]> {
  const out: SourcedText[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdown(path)));
    else if (entry.name.endsWith('.md'))
      out.push({
        source: relative(repository, path),
        text: await readFile(path, 'utf8'),
      });
  }
  return out;
}

const offenders = (texts: (string | SourcedText)[]) =>
  texts.filter((entry) => {
    const { source, text } =
      typeof entry === 'string' ? { source: '', text: entry } : entry;
    if (oldNames.some((name) => name.test(text))) return true;
    if (protocolValues[source]?.includes(text)) return false;
    const prose = (modelRoleTerms[source] ?? []).reduce(
      (value, term) => value.replaceAll(new RegExp(`\\b${term}\\b`, 'g'), ''),
      text,
    );
    return englishChild.test(prose);
  });

function kernelInstructions() {
  return assembleEmployeeKernel({
    employeeAssignmentId: crypto.randomUUID(),
    employeeVersionId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    userMessageId: crypto.randomUUID(),
    assistantMessageId: crypto.randomUUID(),
    workAutomation: { cloud: true, computer: true, assistants: true },
    resolved: {
      promptSnapshot: {
        systemPrompt: 'Platform',
        userRequest: '下面三段文字请分头并行处理',
        conversation: [],
        memories: [],
      },
      executionSnapshot: null,
      grantedCapabilities: ['model:invoke'],
      nativeSkills: [],
    },
  } as unknown as Parameters<typeof assembleEmployeeKernel>[0])
    .systemInstructions;
}

describe('names the model reads (MET-214)', () => {
  it('the assembled work settings and host instructions name 「AllRice 助手」 and 「子智能体」', () => {
    const kernel = kernelInstructions();
    expect(kernel).toContain(
      'computer=automatic within authorized folders and AllRice 助手',
    );
    expect(kernel).toContain(
      '子智能体=allowed if this task has authorized 子智能体',
    );
    const host = dshHostCapabilityInstructions([
      { name: 'python.execute' },
      { name: 'workspace.export.create' },
    ]);
    expect(host).toContain('AllRice 助手');
    expect(offenders([kernel, host])).toEqual([]);
  });

  it('Broker definitions and the platform repository review instructions carry no old name', () => {
    expect(offenders(strings(riceToolDefinitions))).toEqual([]);
    expect(platformRepositoryReviewInstructions).toContain(
      'platform.repository.review',
    );
    expect(offenders([platformRepositoryReviewInstructions])).toEqual([]);
  });

  it('DSH native declarations, prompt sections and governed tool messages carry no old name', async () => {
    const native = (
      await sources(dsh, (name) => name.endsWith('.mjs'))
    ).flatMap(({ name, source }) => literals(name, source));
    expect(native.length).toBeGreaterThan(2000);
    expect(offenders(native)).toEqual([]);
    expect(native.map(({ text }) => text).join('\n')).toContain(
      '子智能体 only: deliver',
    );
    const governed = (
      await sources(harness, (name) => /^assistant-.*\.ts$/.test(name))
    ).flatMap(({ name, source }) => literals(name, source, 'messages'));
    expect(governed.map(({ text }) => text).join('\n')).toContain(
      '当前任务没有这个子智能体',
    );
    expect(offenders(governed)).toEqual([]);
  });

  it('platform Skills carry no old name', async () => {
    const texts = await markdown(join(repository, 'skills'));
    expect(texts.length).toBeGreaterThan(18);
    expect(offenders(texts)).toEqual([]);
  });

  it('rejects 每个 Child assistant in a Skill even alongside model-role wording', async () => {
    const texts = await markdown(join(repository, 'skills'));
    const skill = texts.find(
      ({ source }) => source === 'skills/governed-memory/SKILL.md',
    )!;
    expect(skill.text).toContain('assistant response');
    expect(offenders([skill])).toEqual([]);
    const regressed = { ...skill, text: `${skill.text}\n每个 Child assistant` };
    expect(offenders([regressed])).toEqual([regressed]);
  });

  it('rejects different 子助理 in a tool description', () => {
    const texts = literals(
      'allrice-assistant-runtime.mjs',
      "const tool = { description: 'different 子助理' };",
    );
    expect(offenders(texts)).toEqual([
      { source: 'allrice-assistant-runtime.mjs', text: 'different 子助理' },
    ]);
  });

  it.each(['message', 'summary'])(
    'rejects Assistant stopped in a receipt %s',
    (property) => {
      const texts = literals(
        'assistant-bridge.ts',
        `const receipt = { ${property}: 'Assistant stopped' };`,
        'messages',
      );
      expect(offenders(texts)).toEqual([
        { source: 'assistant-bridge.ts', text: 'Assistant stopped' },
      ]);
    },
  );

  it('exempts exact protocol values without exempting nearby prose', () => {
    const texts = literals(
      'allrice-bootstrap-coverage.mjs',
      "const values = ['assistant', `assistant:${messageId}`, 'assistant/message', 'assistant.report', 'assistant_delegate', 'Assistant stopped'];",
    );
    expect(offenders(texts)).toEqual([
      { source: 'allrice-bootstrap-coverage.mjs', text: 'Assistant stopped' },
    ]);
    expect(offenders(['assistant', 'Assistant stopped'])).toEqual([
      'assistant',
      'Assistant stopped',
    ]);
  });

  it('does not exempt model-role terms in unrelated sources', () => {
    const text = 'assistant response';
    const entry = { source: 'skills/development-cooperation/SKILL.md', text };
    expect(offenders([entry])).toEqual([entry]);
  });
});
