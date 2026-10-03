import { z } from 'zod';
import { NativeFileSurveySchema } from './file-survey.js';
import {
  NativeFileVersionSchema,
  type RuntimeChangeset,
  type ChangesetFileResult,
  type ChangesetExecutionResult,
} from '@allrice/contracts';
import {
  invokeFileGuardian,
  FileGuardianError,
  type FileGuardianControls,
} from './file-guardian.js';

const recovery = z
  .object({
    path: z.string().max(1024),
    checksum: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
const done = z
  .object({
    path: z.string(),
    target: z.string(),
    status: z.enum(['copied', 'moved']),
    file: NativeFileVersionSchema,
    sourceRemoved: z.boolean(),
    recovery,
  })
  .strict();
const failure = z
  .object({
    path: z.string(),
    target: z.string(),
    status: z.enum(['failed', 'unknown']),
    stage: z.string().max(80),
    sourceRemoved: z.boolean(),
    error: z.object({ code: z.string().regex(/^[A-Z_]{1,120}$/) }).strict(),
    recovery: recovery.optional(),
    sourceRecovery: z
      .object({ path: z.string().max(1024) })
      .strict()
      .optional(),
  })
  .strict();

/** The immutable plan and existing prepared journal bracket each native side effect. */
export async function executeFileOrganization(
  root: string,
  payload: RuntimeChangeset,
  controls: FileGuardianControls & {
    checkpoint: (index: number, result: ChangesetFileResult) => Promise<void>;
  },
  initial: ChangesetFileResult[],
  invoke = invokeFileGuardian,
): Promise<ChangesetExecutionResult> {
  const results = structuredClone(initial);
  const report = async (
    i: number,
    status: ChangesetFileResult['status'],
    patch: Partial<ChangesetFileResult> = {},
  ) => {
    const value = { ...results[i]!, ...patch, status };
    await controls.checkpoint(i, value);
    results[i] = value;
  };
  // No binary file is represented as an empty-text deletion or addition.
  for (let i = 0; i < payload.arguments.files.length; i++) {
    const f = payload.arguments.files[i]!;
    if (!('organization' in f)) throw Error('FILE_PLAN_INVALID');
    const item = f.organization;
    try {
      const scan = NativeFileSurveySchema.parse(
        await invoke(
          {
            mode: 'survey',
            root,
            path: item.path,
            maximumEntries: 1,
            maximumHashBytes: 9_000_000,
            hash: true,
          },
          controls,
        ),
      );
      const found = scan.files?.[0];
      if (
        !scan.complete ||
        scan.files?.length !== 1 ||
        found?.path !== item.path ||
        found.checksum !== item.source.checksum ||
        found.sizeBytes !== item.source.sizeBytes ||
        found.version !== item.source.version
      )
        throw new FileGuardianError('FILE_CHANGED');
    } catch (error) {
      await report(i, controls.signal?.aborted ? 'canceled' : 'conflict', {
        errorCode:
          error instanceof FileGuardianError
            ? error.code
            : 'FILE_PREFLIGHT_FAILED',
      });
      return { contractVersion: 1, files: results };
    }
  }
  for (let i = 0; i < payload.arguments.files.length; i++) {
    const f = payload.arguments.files[i]!;
    if (!('organization' in f)) throw Error('FILE_PLAN_INVALID');
    const item = f.organization;
    if (
      controls.signal?.aborted ||
      (controls.authorize && !(await controls.authorize()))
    ) {
      await report(i, 'canceled', { errorCode: 'AUTHORITY_LOST' });
      break;
    }
    await report(i, 'prepared', {
      organization: {
        target: item.target,
        operation: item.operation,
        stage: 'prepared',
        sourceRemoved: false,
      },
    });
    try {
      const native = done.parse(
        await invoke(
          {
            mode: item.operation === 'copy' ? 'copy' : 'move',
            root,
            path: item.path,
            target: item.target,
            expected: item.source,
            expectedDestination: null,
          },
          controls,
        ),
      );
      if (
        native.path !== item.path ||
        native.target !== item.target ||
        native.file.checksum !== item.source.checksum ||
        native.file.sizeBytes !== item.source.sizeBytes ||
        native.status !== (item.operation === 'copy' ? 'copied' : 'moved') ||
        native.sourceRemoved !== (item.operation !== 'copy') ||
        native.recovery.path !== item.target ||
        native.recovery.checksum !== item.source.checksum
      )
        throw new FileGuardianError('FILE_RESULT_UNKNOWN', true);
      await report(i, 'applied', {
        organization: {
          target: item.target,
          operation: item.operation,
          stage: 'complete',
          sourceRemoved: native.sourceRemoved,
          file: native.file,
          recovery: native.recovery,
        },
      });
    } catch (error) {
      const details =
        error instanceof FileGuardianError
          ? failure.safeParse(error.details)
          : null;
      const unknown = !(error instanceof FileGuardianError) || error.unknown;
      await report(
        i,
        unknown
          ? 'unknown'
          : controls.signal?.aborted
            ? 'canceled'
            : 'conflict',
        {
          errorCode:
            error instanceof FileGuardianError
              ? error.code
              : 'FILE_RESULT_UNKNOWN',
          organization: {
            target: item.target,
            operation: item.operation,
            stage: details?.success ? details.data.stage : 'prepared',
            sourceRemoved: details?.success
              ? details.data.sourceRemoved
              : false,
            ...(details?.success && details.data.recovery
              ? { recovery: details.data.recovery }
              : {}),
            ...(details?.success && details.data.sourceRecovery
              ? { sourceRecovery: details.data.sourceRecovery }
              : {}),
          },
        },
      );
      break;
    }
  }
  return { contractVersion: 1, files: results };
}
