/** Durable DSH session journal contract (MET-221).
 *
 * `current` is the contract this build writes; `readsFrom` the oldest it
 * still reads. Raise `current` only for a breaking change (private payloads are
 * strict, so even a new field breaks) and capture a corpus for it with
 * scripts/acceptance/runtime/capture-dsh-journal-v4.ts.
 *
 * NATIVE_JOURNAL_SURFACES is generated: `pnpm dsh:journal-contract -u` rewrites
 * the current descriptor from the sources. Review the diff; a compatible change
 * may update the current version in place. */
export const NATIVE_JOURNAL_CONTRACT = { current: 1, readsFrom: 1 } as const;

export const NATIVE_JOURNAL_SURFACES = {
  '1': {
    privateEvents: {
      types: [
        'allrice/input/answered',
        'allrice/input/request',
        'allrice/wait/checkpoint',
        'allrice/wait/continued',
      ],
      validJournal: null,
      withExtraField: {
        'allrice/wait/checkpoint': 'throws ZodError',
        'allrice/input/request': 'throws ZodError',
        'allrice/input/answered': 'throws ZodError',
        'allrice/wait/continued': 'throws ZodError',
      },
    },
    answerEncoding: {
      prefix: ['allrice:user-question:v1:'],
      occurrences: {
        'apps/worker/dsh/allrice-dsh-runtime-compatibility.mjs': 1,
        'packages/database/migrations/0078_typed_chat_inputs.sql': 2,
        'packages/database/src/conversation/conversation-input.ts': 1,
        'packages/database/src/execution/queue.ts': 1,
        'packages/database/src/task-native-wait.ts': 1,
        'packages/database/src/workspace/service.ts': 3,
        'scripts/acceptance/runtime/b4-dsh-reconciliation.ts': 1,
      },
      submission: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          questionId: { type: 'string', minLength: 1, maxLength: 240 },
          answers: {
            minItems: 1,
            maxItems: 10,
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 240 },
                selected: {
                  maxItems: 20,
                  type: 'array',
                  items: { type: 'string', minLength: 1, maxLength: 240 },
                },
                custom: { type: 'string', minLength: 1, maxLength: 20000 },
              },
              required: ['id', 'selected'],
              additionalProperties: false,
            },
          },
        },
        required: ['questionId', 'answers'],
        additionalProperties: false,
      },
      decoded: {
        'allrice:user-question:v1:': {
          answers: [{ id: 'choice', selected: ['Go'] }],
        },
        'allrice:user-question:v0:': null,
      },
    },
    inputDigest: {
      input: {
        inputId: '33333333-3333-4333-8333-333333333333',
        turnId: 'dsh-vector:turn:1',
        kind: 'steer_current',
        text: 'vector',
      },
      digest:
        'sha256:d4664b6320b19e4d2abef226320ca9b42f4ad60c6e94e27bae006224b56ec2a4',
      recorded: 'pending',
      other: 'throws INPUT_ID_CONFLICT',
    },
    bootstrap: {
      receipt: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          version: { type: 'number', const: 1 },
          scope: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
          imported: {
            maxItems: 81,
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string', minLength: 1, maxLength: 100 },
                digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
              },
              required: ['key', 'digest'],
              additionalProperties: false,
            },
          },
          userMessage: {
            type: 'object',
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 100 },
              digest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
            },
            required: ['key', 'digest'],
            additionalProperties: false,
          },
          assistantMessageId: {
            type: 'string',
            format: 'uuid',
            pattern:
              '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
          },
        },
        required: ['version', 'scope', 'imported'],
        additionalProperties: false,
      },
      assistantSegment: {
        text: 'vector reply',
        key: 'assistant:33333333-3333-4333-8333-333333333333',
        digest:
          'sha256:a4f7f4fc0a871c6d3e6bd3ee2a08e82893f0eea3fff23fc68e885838537d7e5c',
      },
      covered: [
        {
          key: 'assistant:33333333-3333-4333-8333-333333333333',
          digest:
            'sha256:a4f7f4fc0a871c6d3e6bd3ee2a08e82893f0eea3fff23fc68e885838537d7e5c',
        },
      ],
    },
    sessionReference: {
      snapshots: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        maxItems: 3,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              format: 'uuid',
              pattern:
                '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
            },
            label: { type: 'string', minLength: 1, maxLength: 240 },
            visibility: {
              type: 'string',
              enum: ['private', 'workspace', 'organization'],
            },
            capturedAt: {
              type: 'string',
              format: 'date-time',
              pattern:
                '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$',
            },
            checksum: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
            originalMessages: {
              type: 'integer',
              minimum: 0,
              maximum: 9007199254740991,
            },
            truncated: { type: 'boolean' },
            messages: {
              maxItems: 200,
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    format: 'uuid',
                    pattern:
                      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$',
                  },
                  role: { type: 'string', enum: ['user', 'assistant'] },
                  text: { type: 'string', maxLength: 100000 },
                  createdAt: {
                    type: 'string',
                    format: 'date-time',
                    pattern:
                      '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$',
                  },
                },
                required: ['id', 'role', 'text', 'createdAt'],
                additionalProperties: false,
              },
            },
          },
          required: [
            'sessionId',
            'label',
            'visibility',
            'capturedAt',
            'checksum',
            'originalMessages',
            'truncated',
            'messages',
          ],
          additionalProperties: false,
        },
      },
      admission: {
        recorded: ['user', 'session-reference'],
        otherRole: 'throws SESSION_REFERENCE_INVALID_DURABLE_CONTEXT',
        otherSource: 'throws SESSION_REFERENCE_INVALID_DURABLE_CONTEXT',
        textContent: 'throws SESSION_REFERENCE_INVALID_DURABLE_CONTEXT',
        numericId: 'throws SESSION_REFERENCE_INVALID_DURABLE_CONTEXT',
      },
    },
    nativeContextKey: {
      employee: 'S',
      internal: 'N',
      experience: 'experience-O',
    },
    persistence: {
      'allrice-restricted.cordis.yml': {
        attachments: {
          name: '@deepseek-ai/dsh-attachment-local',
          config: {
            dshHome:
              '!!js process.env.DSH_RUNTIME_HOME ?? process.env.DSH_HOME',
            maxImageBytes: 20971520,
            maxImagesPerMessage: 20,
            maxMessageImageBytes: 209715200,
            maxImagePixels: 64000000,
            maxImageDimension: 8192,
            normalizedImageMaxDimension: 2048,
          },
        },
        sessions: {
          name: '@deepseek-ai/dsh-session-persistence-jsonl',
          config: {
            root: '!!js process.env.DSH_SESSION_ROOT',
            compression: 'none',
          },
        },
        'session-checkpoints': {
          name: '@deepseek-ai/dsh-session-checkpoint-policy',
        },
      },
      'allrice-technical.cordis.yml': {
        attachments: {
          name: '@deepseek-ai/dsh-attachment-local',
          config: {
            dshHome:
              '!!js process.env.DSH_RUNTIME_HOME ?? process.env.DSH_HOME',
            maxImageBytes: 20971520,
            maxImagesPerMessage: 20,
            maxMessageImageBytes: 209715200,
            maxImagePixels: 64000000,
            maxImageDimension: 8192,
            normalizedImageMaxDimension: 2048,
          },
        },
        sessions: {
          name: '@deepseek-ai/dsh-session-persistence-jsonl',
          config: {
            root: '!!js process.env.DSH_SESSION_ROOT',
            compression: 'none',
          },
        },
        'session-checkpoints': {
          name: '@deepseek-ai/dsh-session-checkpoint-policy',
        },
      },
      controlProfiles: {
        values: ['allrice-once-control-v1', 'allrice-recurring-control-v1'],
        files: {
          'apps/worker/src/native-schedule-once-loader.ts': 4,
          'apps/worker/src/native-schedule-once-runtime.ts': 2,
          'packages/database/migrations/0202_native_schedule_control_upgrade.sql': 2,
          'packages/database/migrations/0204_native_schedule_calendar_protocol.sql': 1,
          'packages/database/migrations/0207_ordinary_monthly_native.sql': 2,
          'packages/database/migrations/0214_native_control_cloud_absence.sql': 2,
          'packages/database/src/conversation/native-artifact-references.ts': 3,
          'packages/database/src/native-schedule-calendar-sql.ts': 1,
          'packages/database/src/native-schedule-calendar-state.ts': 1,
          'packages/database/src/native-schedule-control-upgrade.ts': 2,
          'packages/database/src/native-schedule-once-product.ts': 1,
          'packages/database/src/native-schedule-recurring-product.ts': 1,
          'packages/database/src/native-schedule-recurring-sql.ts': 1,
          'scripts/dev-release/upgrade-native-schedule-control.mjs': 2,
        },
      },
      controlModules: {
        cordis: { specifier: '@deepseek-ai/cordis', anchor: 'factory' },
        llm: { specifier: '@deepseek-ai/dsh-llm', anchor: 'factory' },
        sessions: { specifier: '@deepseek-ai/dsh-session', anchor: 'factory' },
        projections: {
          specifier: '@deepseek-ai/dsh-session-projection',
          anchor: 'factory',
        },
        systemPrompt: {
          specifier: '@deepseek-ai/dsh-system-prompt',
          anchor: 'factory',
        },
        files: { specifier: '@deepseek-ai/dsh-fs-local', anchor: 'factory' },
        directory: {
          specifier: '@deepseek-ai/dsh-working-directory',
          anchor: 'factory',
        },
        tools: { specifier: '@deepseek-ai/dsh-tools', anchor: 'factory' },
        agents: { specifier: '@deepseek-ai/dsh-agent', anchor: 'factory' },
        loop: { specifier: '@deepseek-ai/dsh-agent-loop', anchor: 'factory' },
        jsonl: {
          specifier: '@deepseek-ai/dsh-session-persistence-jsonl',
          anchor: 'factory',
        },
        storage: { specifier: '@deepseek-ai/dsh-storage', anchor: 'factory' },
        domain: {
          specifier: '@deepseek-ai/dsh-storage-domain',
          anchor: 'factory',
        },
        workspace: {
          specifier: '@deepseek-ai/dsh-workspace',
          anchor: 'factory',
        },
        typert: {
          specifier: '@deepseek-ai/dsh-typert-registry',
          anchor: 'factory',
        },
        defaultModel: {
          specifier: '@deepseek-ai/dsh-agent-default-model',
          anchor: 'factory',
        },
        credentials: {
          specifier: '@deepseek-ai/dsh-credentials',
          anchor: 'factory',
        },
        commands: {
          specifier: '@deepseek-ai/dsh-commands',
          anchor: 'controller',
        },
        connection: {
          specifier: '@deepseek-ai/dsh-client-connection',
          anchor: 'controller',
        },
        attachment: {
          specifier: '@deepseek-ai/dsh-attachment-local',
          anchor: 'factory',
        },
        upload: {
          specifier: '@deepseek-ai/dsh-client-file-upload',
          anchor: 'factory',
        },
        query: {
          specifier: '@deepseek-ai/dsh-session-query-sqlite',
          anchor: 'factory',
        },
        controller: {
          specifier: '@deepseek-ai/dsh-api-session-controller',
          anchor: 'factory',
        },
        sdk: {
          specifier: '@deepseek-ai/dsh-sdk-jsonrpc-server',
          anchor: 'factory',
        },
        schedule: { specifier: '@deepseek-ai/dsh-schedule', anchor: 'factory' },
      },
    },
    sourcePins: {
      'apps/worker/dsh/allrice-session-compatibility.mjs#const text =': [
        'const text = z.string().min(1);',
      ],
      'apps/worker/dsh/allrice-session-compatibility.mjs#const inputId =': [
        'const inputId = z',
        '    .string()',
        '    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);',
      ],
      'apps/worker/dsh/allrice-session-compatibility.mjs#const turnId =': [
        'const turnId = text.regex(/:turn:[1-9][0-9]*$/);',
      ],
      'apps/worker/dsh/allrice-session-compatibility.mjs#const question =': [
        'const question = z',
        '    .object({',
        '    id: text,',
        '    question: text,',
        '    header: z.string().optional(),',
        '    detail: z.string().optional(),',
        '    options: z',
        '        .array(z.object({ label: text, description: z.string().optional() }).strict())',
        '        .optional(),',
        '    multiSelect: z.boolean().optional(),',
        '    intent: z',
        "        .object({ kind: z.literal('plan-review'), approve: text })",
        '        .strict()',
        '        .optional(),',
        '})',
        '    .strict()',
        '    .refine((q) => !q.intent ||',
        "    (typeof q.detail === 'string' &&",
        '        q.options?.some((o) => o.label === q.intent.approve)));',
      ],
      'apps/worker/dsh/allrice-session-compatibility.mjs#const privatePayloads =':
        [
          'const privatePayloads = {',
          "    'allrice/wait/checkpoint': z",
          '        .object({',
          '        sessionId: text,',
          '        questionId: text,',
          '        turnId,',
          '        questions: z.array(question).min(1),',
          '    })',
          '        .strict()',
          "        .refine((p) => p.turnId.startsWith(p.sessionId + ':turn:')),",
          "    'allrice/input/request': z",
          '        .object({',
          '        inputId,',
          '        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),',
          '        messageId: text,',
          '        turnId,',
          '    })',
          '        .strict(),',
          "    'allrice/input/answered': z",
          '        .object({ inputId, questionId: text, turnId })',
          '        .strict(),',
          "    'allrice/wait/continued': z.object({ questionId: text, inputId }).strict(),",
          '};',
        ],
      'apps/worker/dsh/allrice-session-compatibility.mjs#export function validateAllriceSessionJournal(':
        [
          'export function validateAllriceSessionJournal(header, events) {',
          '    const requests = new Map();',
          '    const answers = new Map();',
          '    const checkpoints = new Map();',
          '    const continued = new Set();',
          '    let turn;',
          '    const invalid = () => {',
          "        throw new Error('ALLRICE_SESSION_PRIVATE_FACTS_INVALID');",
          '    };',
          '    for (const event of events) {',
          "        if (event.type === 'turn/start')",
          '            turn = event.data.turn;',
          '        if (!privateTypes.has(event.type))',
          '            continue;',
          '        privatePayloads[event.type].parse(event.data);',
          '        const data = event.data;',
          '        if (header.isSeeded || header.parentSession)',
          '            invalid();',
          '        if (data.turnId !== undefined &&',
          '            data.turnId !== `${header.id}:turn:${turn}`)',
          '            invalid();',
          '        switch (event.type) {',
          "            case 'allrice/wait/checkpoint':",
          '                if (data.sessionId !== header.id || checkpoints.has(data.questionId))',
          '                    invalid();',
          '                if (new Set(data.questions.map((q) => q.id)).size !==',
          '                    data.questions.length)',
          '                    invalid();',
          '                checkpoints.set(data.questionId, data);',
          '                break;',
          "            case 'allrice/input/request':",
          '                if (requests.has(data.inputId))',
          '                    invalid();',
          '                requests.set(data.inputId, data);',
          '                break;',
          "            case 'allrice/input/answered': {",
          '                const request = requests.get(data.inputId);',
          '                if (!request ||',
          '                    answers.has(data.inputId) ||',
          '                    request.turnId !== data.turnId ||',
          '                    request.messageId !== data.questionId)',
          '                    invalid();',
          '                answers.set(data.inputId, data);',
          '                break;',
          '            }',
          "            case 'allrice/wait/continued': {",
          '                const answer = answers.get(data.inputId);',
          '                const checkpoint = checkpoints.get(data.questionId);',
          '                if (!checkpoint ||',
          '                    !answer ||',
          '                    continued.has(data.questionId) ||',
          '                    answer.questionId !== data.questionId ||',
          '                    answer.turnId !== checkpoint.turnId)',
          '                    invalid();',
          '                continued.add(data.questionId);',
          '                break;',
          '            }',
          '        }',
          '    }',
          '}',
        ],
      'apps/worker/dsh/allrice-jsonrpc-implementation.mjs#const message = createUserMessage({ content: contentBlocks,':
        [
          'const message = createUserMessage({',
          '    content: contentBlocks,',
          '    source: {',
          "        kind: 'user',",
          '        ...(context ? { allriceSessionReference: context } : {}),',
          '        ...(params.bootstrapReceipt',
          '            ? {',
          '                allriceBootstrap: BootstrapReceiptSchema.parse(params.bootstrapReceipt),',
          '            }',
          '            : {}),',
          '    },',
          '});',
        ],
      'apps/worker/src/harness/dsh-adapter.ts#const expectedThreadId =': [
        "const expectedThreadId = `dsh-${harnessContextKey(input.kernel)}${input.contentGuard ? `-${input.contentGuard.nativeContextKey ?? input.contentGuard.generationId}` : ''}`;",
      ],
      'apps/worker/src/harness/dsh-adapter.ts#const scope =': [
        "const scope = `sha256:${createHash('sha256')",
        '    .update(JSON.stringify([',
        '    input.kernel.sessionId,',
        '    threadId,',
        '    input.contentGuard?.nativeContextKey ??',
        '        input.contentGuard?.generationId ??',
        '        null,',
        ']))',
        "    .digest('hex')}`;",
      ],
      'apps/worker/src/harness/dsh/runtime-pool.ts#const expectedNamespace =': [
        'const expectedNamespace = originStorageNamespace ??',
        "    resolve(storageRoot, organizationId, workspaceId, ownerId, storageContextKey, 'sessions');",
      ],
      'apps/worker/src/harness/dsh/runtime-pool.ts#tenantRoot: dirname(storageNamespace)':
        ['tenantRoot: dirname(storageNamespace)'],
      'apps/worker/src/harness/dsh/runtime-pool.ts#DSH_RUNTIME_HOME:': [
        'DSH_RUNTIME_HOME: tenantRoot',
      ],
      'apps/worker/src/harness/dsh/runtime-pool.ts#DSH_CWD:': [
        'DSH_CWD: tenantRoot',
      ],
      'apps/worker/src/harness/dsh/runtime-pool.ts#DSH_SESSION_ROOT:': [
        "DSH_SESSION_ROOT: descriptor?.storageNamespace ?? resolve(tenantRoot, 'sessions')",
      ],
      'apps/worker/src/harness/dsh/runtime-pool.ts#cwd: tenantRoot': [
        'cwd: tenantRoot',
        'cwd: tenantRoot',
      ],
      'apps/worker/src/harness/dsh-native-retention.ts#export function employeePreviewStorageRoot(':
        [
          'export function employeePreviewStorageRoot() {',
          "    return resolve(process.env.ALLRICE_EXECUTION_ROOT ?? '.local/executions', 'platform-employee-tests');",
          '}',
        ],
      'apps/worker/dsh/native-schedule-host-factory.mjs#ctx.plugin(m.jsonl,': [
        'ctx.plugin(m.jsonl, {',
        "    root: join(root, 'sessions'),",
        "    compression: 'none',",
        '})',
      ],
      'apps/worker/dsh/native-schedule-host-factory.mjs#server.initialize({ cwd: root,':
        [
          'server.initialize({',
          '    cwd: root,',
          '    provider: PROVIDER,',
          '    model: MODEL,',
          '})',
        ],
    },
    invariants: [
      'A journal lives at <namespace>/-<cwd with / as ->--/<native session id>/session.v4.jsonl; DSH derives the directory from the recorded cwd (the tenant root).',
      'namespace = <ALLRICE_DSH_RUNTIME_ROOT>/<organization>/<workspace>/<owner>/<context key>/sessions: moving ALLRICE_DSH_RUNTIME_ROOT detaches every session.',
    ],
  },
} as const;
