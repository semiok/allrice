/** The durable DSH journal contract (MET-221): what a later build must still
 * read from a session journal. The descriptor is rebuilt from the sources and
 * from real behavior vectors, then compared with the reviewed contracts copy. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  BootstrapReceiptSchema,
  SessionReferenceSnapshotsSchema,
  UserQuestionAnswerSubmissionSchema,
} from '@allrice/contracts';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import { NATIVE_JOURNAL_CONTRACT } from '../../../../packages/contracts/src/native-journal-contract.ts';
import { bootstrapContextForCheckpoint } from '../../src/employee-kernel.js';
import { DshRuntimePool } from '../../src/harness/dsh/runtime-pool.js';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const surfacesPath = resolve(
  root,
  'packages/contracts/src/native-journal-contract.surfaces.json',
);

// Every committed production source, so a new producer or parser must be
// acknowledged in review.
const sources = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter(
    (path) =>
      /\.(?:[cm]?[jt]sx?|sql)$/.test(path) &&
      !/(?:^|\/)(?:test|tests|fixtures)\/|\.test\.[cm]?[jt]sx?$/.test(path) &&
      existsSync(resolve(root, path)),
  )
  .map((path) => [path, read(path)] as const);
const literals = (pattern: RegExp, within = ['']) => {
  const scoped = sources.filter(([path]) =>
    within.some((prefix) => path.startsWith(prefix)),
  );
  return {
    values: [
      ...new Set(scoped.flatMap(([, text]) => text.match(pattern) ?? [])),
    ].sort(),
    files: Object.fromEntries(
      scoped.flatMap(([path, text]) => {
        const count = text.match(pattern)?.length;
        return count ? [[path, count]] : [];
      }),
    ),
  };
};

// Private types are registered by import side effect; this file's fresh module
// graph shows exactly the ones every registering adapter module adds.
const registering = sources
  .filter(
    ([path, text]) =>
      path.startsWith('apps/worker/dsh/') &&
      text.includes('KNOWN_SESSION_EVENT_TYPES'),
  )
  .map(([path]) => path);
const known = new Set(KNOWN_SESSION_EVENT_TYPES);
const [inputs, waits, journal, answers, bootstrap, references, schedule] =
  await Promise.all(
    [
      'allrice-dsh-inputs',
      'allrice-dsh-waits',
      'allrice-session-compatibility',
      'allrice-dsh-runtime-compatibility',
      'allrice-bootstrap-coverage',
      'allrice-session-references',
      'native-schedule-host-factory',
    ].map((name) => import(resolve(root, `apps/worker/dsh/${name}.mjs`))),
  );
await Promise.all(registering.map((path) => import(resolve(root, path))));
const privateEventTypes = [...KNOWN_SESSION_EVENT_TYPES]
  .filter((type) => !known.has(type))
  .sort();

const jsTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (js: string) => `!!js ${js}`,
};
const persistence = (profile: string) =>
  Object.fromEntries(
    (
      parseDocument(read(`apps/worker/dsh/${profile}`), {
        customTags: [jsTag],
      }).toJS() as { id: string }[]
    )
      .filter(({ id }) =>
        ['attachments', 'sessions', 'session-checkpoints'].includes(id),
      )
      .map(({ id, ...plugin }) => [id, plugin]),
  );

// Formulas without an exported behavior, pinned as comment-free source: the
// outermost node whose whitespace-collapsed text starts with each prefix.
const pins: [file: string, ...prefixes: string[]][] = [
  [
    'apps/worker/dsh/allrice-session-compatibility.mjs',
    'const text =',
    'const inputId =',
    'const turnId =',
    'const question =',
    'const privatePayloads =',
    'export function validateAllriceSessionJournal(',
  ],
  [
    'apps/worker/dsh/allrice-jsonrpc-implementation.mjs',
    'const message = createUserMessage({ content: contentBlocks,',
  ],
  [
    'apps/worker/src/harness/dsh-adapter.ts',
    'const expectedThreadId =',
    'const scope =',
  ],
  [
    'apps/worker/src/harness/dsh/runtime-pool.ts',
    'DSH_RUNTIME_HOME:',
    'DSH_CWD:',
    'DSH_SESSION_ROOT:',
    'cwd: tenantRoot',
  ],
  ['apps/worker/src/platform-employee-tests.ts', 'const testDirectory ='],
  [
    'apps/worker/src/harness/dsh-native-retention.ts',
    'export function employeePreviewStorageRoot(',
  ],
  [
    'apps/worker/dsh/native-schedule-host-factory.mjs',
    'ctx.plugin(m.jsonl,',
    'server.initialize({ cwd: root,',
  ],
];
const printer = ts.createPrinter({ removeComments: true });
const sourcePins: Record<string, string[]> = {};
for (const [file, ...prefixes] of pins) {
  const source = ts.createSourceFile(
    file,
    read(file),
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node): void => {
    const text = node.getText(source).replace(/\s+/g, ' ');
    const prefix = prefixes.find((value) => text.startsWith(value));
    if (!prefix) return void ts.forEachChild(node, visit);
    (sourcePins[`${file}#${prefix}`] ??= []).push(
      ...printer.printNode(ts.EmitHint.Unspecified, node, source).split('\n'),
    );
  };
  ts.forEachChild(source, visit);
  for (const prefix of prefixes)
    if (!sourcePins[`${file}#${prefix}`])
      throw new Error(`Journal contract pin not found: ${file}#${prefix}`);
}

// Parked question ids and option labels that a later build matches by value:
// the lines of every string, template or regex literal carrying one, per file.
const durable =
  /runtime-progress|重新检查后继续|取消任务|app-connect:|已连接，继续任务/;
const durableQuestions = Object.fromEntries(
  sources
    .filter(
      ([path, text]) =>
        /^(?:apps\/worker|packages\/database)\/.*\.[cm]?[jt]s$/.test(path) &&
        durable.test(text),
    )
    .map(([path, text]) => {
      const source = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        const literal =
          ts.isStringLiteralLike(node) ||
          ts.isTemplateExpression(node) ||
          ts.isRegularExpressionLiteral(node);
        if (literal && durable.test(node.getText(source)))
          found.push(
            ...node
              .getText(source)
              .split('\n')
              .filter((line) => durable.test(line))
              .map((line) => line.trim()),
          );
        else ts.forEachChild(node, visit);
      };
      ts.forEachChild(source, visit);
      return [path, found];
    }),
);

/** A behavior vector's outcome: its value, or what it throws. */
async function outcome(run: () => unknown) {
  try {
    return (await run()) ?? null;
  } catch (error) {
    const { name, message } = error as Error;
    return `throws ${name === 'ZodError' ? name : message}`;
  }
}
const sessionId = 'dsh-vector';
const turnId = `${sessionId}:turn:1`;
const inputId = '33333333-3333-4333-8333-333333333333';
const question = { id: 'choice', question: 'Go?', options: [{ label: 'Go' }] };
const facts = {
  'allrice/wait/checkpoint': {
    sessionId,
    questionId: 'q',
    turnId,
    questions: [question],
  },
  'allrice/input/request': {
    inputId,
    digest: `sha256:${'0'.repeat(64)}`,
    messageId: 'q',
    turnId,
  },
  'allrice/input/answered': { inputId, questionId: 'q', turnId },
  'allrice/wait/continued': { questionId: 'q', inputId },
};
const validate = (extra?: string) =>
  outcome(() =>
    journal.validateAllriceSessionJournal({ id: sessionId }, [
      { type: 'turn/start', data: { turn: 1 } },
      ...Object.entries(facts).map(([type, data]) => ({
        type,
        data: type === extra ? { ...data, extra: 1 } : data,
      })),
    ]),
  );

// The digest an input request records, read from the real producer.
const input = { inputId, turnId, kind: 'steer_current', text: 'vector' };
const appended: { type: string; data: { digest: string } }[] = [];
await inputs.deliverDshInput(
  {
    agent: {
      status: 'running',
      session: {
        snapshotEvents: () => [
          { type: 'turn/start', seq: 1, data: { turn: 1 } },
          ...appended.map((event, index) => ({ ...event, seq: index + 2 })),
        ],
        append: (type: string, data: { digest: string }) =>
          appended.push({ type, data }),
      },
      inbox: { nextStep: [], nextTurn: [] },
    },
    sessionId,
    pendingQuestion: null,
    notify() {},
    flush: async () => {},
    isCurrent: () => false,
  },
  input,
);
const inspect = (digest: string) =>
  outcome(
    () =>
      inputs.inspectDshInput(
        {
          session: {
            snapshotEvents: () => [
              {
                type: 'allrice/input/request',
                seq: 1,
                data: { ...input, digest, messageId: 'm' },
              },
            ],
          },
          inbox: { nextStep: [{ id: 'm' }], nextTurn: [] },
        },
        input,
      ).status,
  );

const prefixes = literals(/allrice:user-question:v\d+:/g);
const answer = JSON.stringify({
  questionId: 'q',
  answers: [{ id: 'choice', selected: ['Go'] }],
});

// Kernel segment digests, checkpoint included, must be the ones the runtime
// covers; the assistant one is recomputed by the runtime from the journal.
const assistant = { id: inputId, role: 'assistant', text: 'vector reply' };
const segments = bootstrapContextForCheckpoint(
  [assistant] as never,
  {
    summaryVersion: 'extractive-v1',
    generation: 2,
    coveredThroughMessageId: null,
    summary: 'vector summary',
  } as never,
)!.segments.map(({ key, digest }) => ({ key, digest }));
const scope = `sha256:${'c'.repeat(64)}`;
const receipt = {
  version: 1,
  scope,
  imported: segments.filter(({ key }) => key === 'checkpoint'),
  assistantMessageId: inputId,
};
const assistantText = [{ type: 'text', text: assistant.text }];

let admit!: (
  event: object,
  next: () => Promise<object>,
) => Promise<{ messages: { source: { kind: string } }[] }>;
references.installSessionReferenceAdmission({
  on: (_: string, handler: typeof admit) => (admit = handler),
});
const reference = {
  id: 'r',
  role: 'user',
  content: [],
  source: { kind: 'session-reference' },
};
const admitted = (allriceSessionReference: object) =>
  outcome(async () =>
    (
      await admit({}, async () => ({
        kind: 'accept',
        messages: [
          {
            id: 'm',
            role: 'user',
            content: [],
            source: { kind: 'user', allriceSessionReference },
          },
        ],
      }))
    ).messages.map((message) => message.source.kind),
  );

// The storage location itself (DshRuntimePool.storage is pure: no
// credentials, mkdir or launch), from a configured and a default runtime root.
function storage(runtimeRoot: string | undefined, show: (p: string) => string) {
  const saved = process.env.ALLRICE_DSH_RUNTIME_ROOT;
  if (runtimeRoot) process.env.ALLRICE_DSH_RUNTIME_ROOT = runtimeRoot;
  else delete process.env.ALLRICE_DSH_RUNTIME_ROOT;
  try {
    const pool = new DshRuntimePool() as unknown as {
      storage(input: object): Record<string, string>;
    };
    const executionEnvironment = {
      ALLRICE_ORGANIZATION_ID: '11111111-1111-4111-8111-111111111111',
      ALLRICE_WORKSPACE_ID: '22222222-2222-4222-8222-222222222222',
      ALLRICE_OWNER_ID: inputId,
    };
    return Object.fromEntries(
      Object.entries({
        employee: { sessionId: 'S' },
        internal: { sessionId: null, internalTask: {}, nativeContextId: 'N' },
        experience: { sessionId: null, internalTask: { occurrenceId: 'O' } },
      }).map(([kind, kernel]) => {
        const located = pool.storage({ executionEnvironment, kernel });
        return [
          kind,
          {
            storageContextKey: located.storageContextKey,
            tenantRoot: show(located.tenantRoot!),
            storageNamespace: show(located.storageNamespace!),
          },
        ];
      }),
    );
  } finally {
    if (saved === undefined) delete process.env.ALLRICE_DSH_RUNTIME_ROOT;
    else process.env.ALLRICE_DSH_RUNTIME_ROOT = saved;
  }
}

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { unrepresentable: 'any' });
const surfaces = {
  privateEvents: {
    types: privateEventTypes,
    registeredBy: registering,
    appended: literals(/\.append\(\s*'allrice\/[\w/-]+'/g, ['apps/worker/']),
    validJournal: await validate(),
    withExtraField: Object.fromEntries(
      await Promise.all(
        Object.keys(facts).map(async (type) => [type, await validate(type)]),
      ),
    ),
  },
  answerEncoding: {
    prefix: prefixes.values,
    occurrences: prefixes.files,
    submission: jsonSchema(UserQuestionAnswerSubmissionSchema),
    decoded: Object.fromEntries(
      await Promise.all(
        [...prefixes.values, 'allrice:user-question:v0:'].map(
          async (prefix) => [
            prefix,
            await outcome(() =>
              answers.structuredUserQuestionAnswer(
                { questionId: 'q', questions: [question] },
                prefix + answer,
              ),
            ),
          ],
        ),
      ),
    ),
  },
  durableQuestions,
  inputDigest: {
    input,
    digest: appended[0]?.data.digest,
    recorded: await inspect(appended[0]!.data.digest),
    other: await inspect(`sha256:${'0'.repeat(64)}`),
  },
  bootstrap: {
    receipt: jsonSchema(BootstrapReceiptSchema),
    kernelSegments: segments,
    covered: bootstrap.readBootstrapCoverage(
      {
        seq: 2,
        snapshotEvents: () => [
          {
            type: 'user/message',
            data: { source: { kind: 'user', allriceBootstrap: receipt } },
          },
          {
            type: 'assistant/message',
            data: { message: { content: assistantText } },
          },
        ],
      },
      { scope, candidates: segments },
    ).covered,
  },
  sessionReference: {
    snapshots: jsonSchema(SessionReferenceSnapshotsSchema),
    admission: {
      recorded: await admitted(reference),
      otherRole: await admitted({ ...reference, role: 'assistant' }),
      otherSource: await admitted({ ...reference, source: { kind: 'user' } }),
      textContent: await admitted({ ...reference, content: 'text' }),
      numericId: await admitted({ ...reference, id: 1 }),
    },
  },
  storage: {
    configured: storage('/allrice/runtime-root', (path) => path),
    default: storage(undefined, (path) => relative(process.cwd(), path)),
  },
  persistence: {
    'allrice-restricted.cordis.yml': persistence(
      'allrice-restricted.cordis.yml',
    ),
    'allrice-technical.cordis.yml': persistence('allrice-technical.cordis.yml'),
    controlProfiles: literals(/allrice-(?:once|recurring)-control-v\d+/g),
    controlModules: schedule.nativeScheduleModuleMap,
  },
  sourcePins,
};

it('matches the reviewed descriptor of the current contract version', async () => {
  const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
  expect(Number.isInteger(readsFrom) && readsFrom >= 1).toBe(true);
  expect(Number.isInteger(current) && current >= readsFrom).toBe(true);
  const reviewed = JSON.parse(readFileSync(surfacesPath, 'utf8'));
  const kept = Object.fromEntries(
    Object.entries({ ...reviewed, [current]: surfaces })
      .filter(([version]) => Number(version) >= readsFrom)
      .sort(([a], [b]) => Number(a) - Number(b)),
  );
  // Every readable version keeps its reviewed descriptor.
  expect(Object.keys(kept).map(Number)).toEqual(
    Array.from({ length: current - readsFrom + 1 }, (_, i) => readsFrom + i),
  );
  // A version is raised only for a changed surface. The constant is outside the
  // native artifact, so a bare bump would keep the artifact ID yet raise the
  // database high-water and make every rollback refuse (MET-221).
  if (current > readsFrom)
    expect(
      kept[current],
      'current raised without a surface change',
    ).not.toEqual(kept[current - 1]);
  const text = await format(JSON.stringify(kept), {
    ...(await resolveConfig(surfacesPath)),
    filepath: surfacesPath,
  });
  await expect(text).toMatchFileSnapshot(surfacesPath);
});

interface WrittenEvent {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

function recordingJournal() {
  const events: WrittenEvent[] = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
  ];
  return {
    events,
    session: {
      snapshotEvents: () => events,
      append(type: string, data: Record<string, unknown>) {
        events.push({ type, data, seq: events.length + 1 });
      },
    },
  };
}

// Reader vectors alone do not check what each live producer persists. Keep
// emitted payloads inside the strict journal contract, including steer_current.
it.each(['steer_current', 'ask_user'] as const)(
  'writes %s input events that the journal reader accepts',
  async (kind) => {
    const { events, session } = recordingJournal();
    const inbox = { nextStep: [] as { id: string }[], nextTurn: [] };
    const result = await inputs.deliverDshInput(
      {
        agent: {
          status: kind === 'ask_user' ? 'idle' : 'running',
          session,
          inbox,
          steer: (message: { id: string }) => inbox.nextStep.push(message),
        },
        sessionId,
        pendingQuestion:
          kind === 'ask_user'
            ? { questionId: 'q', questions: [question], resolve() {} }
            : null,
        notify() {},
        flush: async () => {},
        isCurrent: () => true,
        suspended: kind === 'ask_user',
      },
      {
        ...input,
        kind,
        text:
          kind === 'ask_user'
            ? `allrice:user-question:v1:${answer}`
            : input.text,
      },
    );
    expect(result.status).toBe(kind === 'ask_user' ? 'adopted' : 'pending');
    expect(events.map((event) => event.type)).toEqual([
      'turn/start',
      'allrice/input/request',
      ...(kind === 'ask_user' ? ['allrice/input/answered'] : []),
    ]);
    expect(() =>
      journal.validateAllriceSessionJournal({ id: sessionId }, events),
    ).not.toThrow();
  },
);

// MET-210: skipped items ({ selected: [] }) are answers, partly or wholly;
// a batch missing, repeating or inventing an item is still rejected.
it.each([
  [
    'partly skipped',
    'q',
    [
      ['choice', ['Go']],
      ['scope', []],
    ],
    'adopted',
  ],
  [
    'wholly skipped',
    'q',
    [
      ['choice', []],
      ['scope', []],
    ],
    'adopted',
  ],
  ['missing an item', 'q', [['choice', []]], 'QUESTION_ANSWER_INVALID'],
  [
    'repeating an item',
    'q',
    [
      ['choice', []],
      ['choice', []],
    ],
    'QUESTION_ANSWER_INVALID',
  ],
  [
    'for another question',
    'other',
    [
      ['choice', []],
      ['scope', []],
    ],
    'QUESTION_ANSWER_INVALID',
  ],
  [
    'with an unknown option',
    'q',
    [
      ['choice', []],
      ['scope', ['None']],
    ],
    'QUESTION_ANSWER_INVALID',
  ],
  [
    'repeating a selection',
    'q',
    [
      ['choice', []],
      ['many', ['A', 'A']],
    ],
    'QUESTION_ANSWER_REQUIRED',
  ],
] as const)(
  'a question batch %s is checked like any other answer',
  async (_case, questionId, items, outcome) => {
    const { session } = recordingJournal();
    const second = items.some(([id]) => id === 'many')
      ? {
          id: 'many',
          question: 'Which?',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        }
      : {
          id: 'scope',
          question: 'Scope?',
          options: [{ label: 'All' }, { label: 'Some' }],
        };
    const delivery = inputs.deliverDshInput(
      {
        agent: {
          status: 'idle',
          session,
          inbox: { nextStep: [], nextTurn: [] },
        },
        sessionId,
        pendingQuestion: {
          questionId: 'q',
          questions: [question, second],
          resolve() {},
        },
        notify() {},
        flush: async () => {},
        isCurrent: () => true,
        suspended: true,
      },
      {
        ...input,
        kind: 'ask_user',
        text: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: items.map(([id, selected]) => ({ id, selected })) })}`,
      },
    );
    if (outcome === 'adopted') expect((await delivery).status).toBe('adopted');
    else await expect(delivery).rejects.toThrow(outcome);
  },
);

// MET-210: a skipped item ({ selected: [] }) on the parked "运行进度暂停"
// card resumes as a cancellation, never as agreement to continue.
it('resumes a skipped parked runtime-progress card as a cancellation', async () => {
  const { session } = recordingJournal();
  const agent = {
    status: 'running',
    session,
    inbox: { nextStep: [], nextTurn: [] },
    cancel() {
      agent.status = 'idle';
    },
    whenIdle: async () => {},
  };
  const record = { agent };
  const progress = {
    id: 'runtime-progress',
    question: '是否调整后继续？',
    options: [{ label: '重新检查后继续' }, { label: '取消任务' }],
  };
  const decisions: unknown[] = [];
  const server = {
    requireRoot: () => record,
    ensureRoot: async () => record,
    assertRoot() {},
    isRootCurrent: () => true,
    pendingUserQuestions: new Map([
      [sessionId, { questionId: 'q', questions: [progress] }],
    ]),
    ctx: {
      agents: { list: () => [agent] },
      sessions: { flush: async () => {} },
    },
    userQuestionNotify() {},
    prompt: async () => ({ accepted: true }),
    progressBridge: async (p: { action: string; decision?: string }) => {
      if (p.action === 'decide') decisions.push(p.decision);
      return { paused: true, pauseId: 'one' };
    },
  };
  await waits.checkpointNativeQuestion(server, sessionId, 'q');
  await expect(
    waits.continueNativeWait(server, {
      sessionId,
      questionId: 'q',
      turnId,
      inputId,
      text: `allrice:user-question:v1:${JSON.stringify({ questionId: 'q', answers: [{ id: 'runtime-progress', selected: [] }] })}`,
    }),
  ).rejects.toThrow('task_progress_canceled');
  expect(decisions).toEqual(['cancel']);
});

it('writes a checkpoint and continuation that the journal reader accepts', async () => {
  const { events, session } = recordingJournal();
  const agent = {
    status: 'running',
    session,
    inbox: { nextStep: [], nextTurn: [] },
    cancel() {
      agent.status = 'idle';
    },
    whenIdle: async () => {},
  };
  const record = { agent };
  const server = {
    requireRoot: () => record,
    ensureRoot: async () => record,
    assertRoot() {},
    isRootCurrent: () => true,
    pendingUserQuestions: new Map([
      [sessionId, { questionId: 'q', questions: [question] }],
    ]),
    ctx: {
      agents: { list: () => [agent] },
      sessions: { flush: async () => {} },
    },
    userQuestionNotify() {},
    prompt: async () => ({ accepted: true }),
  };
  expect(
    await waits.checkpointNativeQuestion(server, sessionId, 'q'),
  ).toMatchObject(facts['allrice/wait/checkpoint']);
  await waits.continueNativeWait(server, {
    sessionId,
    questionId: 'q',
    turnId,
    inputId,
    text: `allrice:user-question:v1:${answer}`,
  });
  expect(events.map((event) => event.type)).toEqual([
    'turn/start',
    'allrice/wait/checkpoint',
    'allrice/input/request',
    'allrice/input/answered',
    'allrice/wait/continued',
  ]);
  expect(() =>
    journal.validateAllriceSessionJournal({ id: sessionId }, events),
  ).not.toThrow();
});
