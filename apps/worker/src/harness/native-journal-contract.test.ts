/** The durable DSH journal contract (MET-221): what a later build must still
 * read from a session journal. The descriptor is rebuilt from the sources and
 * from real behavior vectors, then compared with the reviewed contracts copy. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BootstrapReceiptSchema,
  harnessContextKey,
  SessionReferenceSnapshotsSchema,
  UserQuestionAnswerSubmissionSchema,
} from '@allrice/contracts';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { z } from 'zod';

import {
  NATIVE_JOURNAL_CONTRACT,
  NATIVE_JOURNAL_SURFACES,
} from '../../../../packages/contracts/src/native-journal-contract.ts';
import { bootstrapContextForCheckpoint } from '../employee-kernel.js';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const contractPath = 'packages/contracts/src/native-journal-contract.ts';

// Private types are registered by import side effect; this file's fresh module
// graph shows exactly the ones the adapter modules add.
const known = new Set(KNOWN_SESSION_EVENT_TYPES);
const [inputs, , journal, answers, bootstrap, references, schedule] =
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
const privateEventTypes = [...KNOWN_SESSION_EVENT_TYPES]
  .filter((type) => !known.has(type))
  .sort();

// Every production source, so a new producer or parser must be acknowledged.
const sources = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' },
)
  .split('\0')
  .filter(
    (path) =>
      /\.(?:[cm]?[jt]sx?|sql)$/.test(path) &&
      !/(?:^|\/)(?:test|tests|fixtures)\/|\.test\.[cm]?[jt]sx?$/.test(path) &&
      path !== contractPath,
  )
  .map((path) => [path, read(path)] as const);
const literals = (pattern: RegExp) => ({
  values: [
    ...new Set(sources.flatMap(([, text]) => text.match(pattern) ?? [])),
  ].sort(),
  files: Object.fromEntries(
    sources.flatMap(([path, text]) => {
      const count = text.match(pattern)?.length;
      return count ? [[path, count]] : [];
    }),
  ),
});

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
    'const expectedNamespace =',
    'tenantRoot: dirname(storageNamespace)',
    'DSH_RUNTIME_HOME:',
    'DSH_CWD:',
    'DSH_SESSION_ROOT:',
    'cwd: tenantRoot',
  ],
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

// The kernel's segment digest must be the one the runtime covers.
const assistant = { id: inputId, role: 'assistant', text: 'vector reply' };
const { key, digest } = bootstrapContextForCheckpoint([assistant] as never)!
  .segments[0]!;
const scope = `sha256:${'c'.repeat(64)}`;
const receipt = {
  version: 1,
  scope,
  imported: [],
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

const jsonSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { unrepresentable: 'any' });
const surfaces = {
  privateEvents: {
    types: privateEventTypes,
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
  inputDigest: {
    input,
    digest: appended[0]?.data.digest,
    recorded: await inspect(appended[0]!.data.digest),
    other: await inspect(`sha256:${'0'.repeat(64)}`),
  },
  bootstrap: {
    receipt: jsonSchema(BootstrapReceiptSchema),
    assistantSegment: { text: assistant.text, key, digest },
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
      { scope, candidates: [{ key, digest }] },
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
  nativeContextKey: {
    employee: harnessContextKey({ sessionId: 'S' } as never),
    internal: harnessContextKey({
      internalTask: {},
      nativeContextId: 'N',
    } as never),
    experience: harnessContextKey({
      internalTask: { occurrenceId: 'O' },
    } as never),
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
  invariants: [
    'A journal lives at <namespace>/-<cwd with / as ->--/<native session id>/session.v4.jsonl; DSH derives the directory from the recorded cwd (the tenant root).',
    'namespace = <ALLRICE_DSH_RUNTIME_ROOT>/<organization>/<workspace>/<owner>/<context key>/sessions: moving ALLRICE_DSH_RUNTIME_ROOT detaches every session.',
  ],
};

const header = `/** Durable DSH session journal contract (MET-221).
 *
 * \`current\` is the contract this build writes; \`readsFrom\` the oldest it
 * still reads. Raise \`current\` only for a breaking change (private payloads are
 * strict, so even a new field breaks) and capture a corpus for it with
 * scripts/acceptance/runtime/capture-dsh-journal-v4.ts.
 *
 * NATIVE_JOURNAL_SURFACES is generated: \`pnpm dsh:journal-contract -u\` rewrites
 * the current descriptor from the sources. Review the diff; a compatible change
 * may update the current version in place. */`;

it('matches the reviewed descriptor of the current contract version', async () => {
  const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
  expect(Number.isInteger(readsFrom) && readsFrom >= 1).toBe(true);
  expect(Number.isInteger(current) && current >= readsFrom).toBe(true);
  const kept = Object.fromEntries(
    Object.entries({ ...NATIVE_JOURNAL_SURFACES, [current]: surfaces })
      .filter(([version]) => Number(version) >= readsFrom)
      .sort(([a], [b]) => Number(a) - Number(b)),
  );
  // Every readable version keeps its reviewed descriptor.
  expect(Object.keys(kept).map(Number)).toEqual(
    Array.from({ length: current - readsFrom + 1 }, (_, i) => readsFrom + i),
  );
  const path = resolve(root, contractPath);
  const text = await format(
    `${header}\nexport const NATIVE_JOURNAL_CONTRACT = ${JSON.stringify({ current, readsFrom })} as const;\n\nexport const NATIVE_JOURNAL_SURFACES = ${JSON.stringify(kept)} as const;\n`,
    { ...(await resolveConfig(path)), filepath: path },
  );
  await expect(text).toMatchFileSnapshot(path);
});
