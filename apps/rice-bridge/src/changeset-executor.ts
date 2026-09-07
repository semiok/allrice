import { createHash } from 'node:crypto';
import {
  RuntimeChangesetSchema,
  type RuntimeChangeset,
  type ChangesetFileResult,
  type ChangesetExecutionResult,
} from '@allrice/contracts';
import {
  LocalExecutionError,
  checkChangesetFile,
  writeTextFile,
  removeChangesetFile,
} from './executor.js';

export function initialChangesetResults(
  payload: RuntimeChangeset,
): ChangesetFileResult[] {
  return payload.arguments.files.map((f) => ({
    path: f.path,
    status: 'pending',
    beforeChecksum: f.before?.checksum ?? null,
    afterChecksum: f.after?.checksum ?? null,
  }));
}
/** Journal checkpoints bracket each real side effect. No retry loop or auto-resume. */
export async function executeChangeset(
  root: string,
  input: RuntimeChangeset,
  controls: {
    checkpoint: (index: number, result: ChangesetFileResult) => Promise<void>;
    authorize: () => Promise<boolean>;
  },
): Promise<ChangesetExecutionResult> {
  const payload = RuntimeChangesetSchema.parse(input),
    results = initialChangesetResults(payload);
  const report = async (
    index: number,
    status: ChangesetFileResult['status'],
    errorCode?: string,
  ) => {
    const result = {
      ...results[index]!,
      status,
      ...(errorCode ? { errorCode } : {}),
    };
    await controls.checkpoint(index, result);
    results[index] = result;
  };
  // Verify all supplied texts and initial baselines before touching any path.
  for (let i = 0; i < payload.arguments.files.length; i++) {
    const f = payload.arguments.files[i]!;
    try {
      for (const side of [f.before, f.after])
        if (
          side &&
          (Buffer.byteLength(side.text) > 200_000 ||
            side.text.includes('\0') ||
            `sha256:${createHash('sha256').update(side.text).digest('hex')}` !==
              side.checksum)
        )
          throw new LocalExecutionError(
            'WRITE_CONFLICT',
            'Payload hash mismatch',
          );
      await checkChangesetFile(root, f.path, f.before?.checksum ?? null);
    } catch (error) {
      await report(
        i,
        'conflict',
        error instanceof LocalExecutionError ? error.code : 'PREFLIGHT_FAILED',
      );
      return { contractVersion: 1, files: results };
    }
  }
  for (let i = 0; i < payload.arguments.files.length; i++) {
    const file = payload.arguments.files[i]!;
    try {
      if (!(await controls.authorize())) {
        await report(i, 'canceled', 'AUTHORITY_LOST');
        break;
      }
      await report(i, 'prepared');
      const beforeCommit = async () => {
        if (!(await controls.authorize()))
          throw new LocalExecutionError(
            'WRITE_CONFLICT',
            'Authority changed before commit',
          );
      };
      if (file.after)
        await writeTextFile(
          root,
          file.path,
          file.after.text,
          file.before?.checksum ?? null,
          beforeCommit,
        );
      else
        await removeChangesetFile(
          root,
          file.path,
          file.before!.checksum,
          beforeCommit,
        );
      await report(i, 'applied');
    } catch (error) {
      // Typed precondition failures are known no-effect; I/O failures could occur
      // after rename/unlink or fsync. Keep that one file unknown, never replay it.
      await report(
        i,
        error instanceof LocalExecutionError ? 'conflict' : 'unknown',
        error instanceof LocalExecutionError
          ? error.code
          : 'WRITE_OUTCOME_UNKNOWN',
      );
      break;
    }
  }
  return { contractVersion: 1, files: results };
}
