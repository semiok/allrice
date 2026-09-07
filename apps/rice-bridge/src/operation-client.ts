import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import {
  RuntimeBridgeDispatchSchema,
  RuntimeBridgeReceiptAckSchema,
  RuntimeBridgeStartResponseSchema,
  runtimeContractEqual,
  type RuntimeBridgeDispatch,
} from '@allrice/contracts';

import { bridgeRequest } from './client.js';
import type { BridgeConfig } from './config.js';
import { executeLocalCommand } from './executor.js';
import { BridgeJournalError, type BridgeJournal } from './journal.js';

export const runtimeBridgeOperationPath = '/api/v1/bridge/device/operations';

/** All retries in this adapter deliver evidence; they never repeat execution. */
export class RuntimeBridgeOperationClient {
  constructor(
    private readonly input: {
      config: BridgeConfig;
      token: string;
      journal: BridgeJournal;
      // Test seams retain the real filesystem journal and HTTP adapter.
      execute?: typeof executeLocalCommand;
    },
  ) {
    input.journal.assertIdentity(input.config.server, input.config.deviceId);
  }

  async flush() {
    for (const receipt of await this.input.journal.pending()) {
      const ack = RuntimeBridgeReceiptAckSchema.parse(
        await bridgeRequest({
          server: this.input.config.server,
          path: `${runtimeBridgeOperationPath}/${receipt.attempt.operationId}/receipts`,
          method: 'POST',
          token: this.input.token,
          body: receipt,
          maximumResponseBytes: 32_768,
        }),
      );
      if (ack.receiptId !== receipt.receiptId)
        throw new BridgeJournalError('JOURNAL_ACK_MISMATCH');
      await this.input.journal.acknowledge(receipt.receiptId);
    }
    return (await this.input.journal.pending(1)).length === 0;
  }

  async pollOnce() {
    // A failed/full outbox prevents acquiring more work, providing backpressure.
    if (!(await this.flush())) return false;
    const response = await bridgeRequest<{ dispatch: unknown }>({
      server: this.input.config.server,
      path: `${runtimeBridgeOperationPath}/next`,
      method: 'POST',
      token: this.input.token,
      maximumResponseBytes: 750_000,
    });
    if (response.dispatch === null) return false;
    await this.handle(RuntimeBridgeDispatchSchema.parse(response.dispatch));
    await this.flush();
    return true;
  }

  async handle(dispatch: RuntimeBridgeDispatch) {
    const { journal, config, token } = this.input;
    const operationId = dispatch.snapshot.binding.attempt.operationId;
    if ((await journal.receive(dispatch)) === 'duplicate') return;
    const grant = config.grants.find(
      (item) => item.id === dispatch.snapshot.binding.execution.grantId,
    );
    const root = grant
      ? await realpath(grant.rootPath).catch(() => null)
      : null;
    if (
      !grant ||
      !root ||
      grant.rootFingerprint !== dispatch.grantRootFingerprint ||
      createHash('sha256').update(root).digest('hex') !==
        dispatch.grantRootFingerprint
    ) {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary: 'Local folder grant does not match this dispatch',
        errorCode: 'GRANT_MISMATCH',
      });
      return;
    }
    try {
      journal.assertWorkspace(root);
    } catch {
      await journal.outcome(operationId, {
        status: 'failed',
        effects: 'none',
        summary:
          'Choose a project folder that does not contain the Bridge journal',
        errorCode: 'WORKSPACE_CONTAINS_JOURNAL',
      });
      return;
    }
    if (Date.parse(dispatch.leaseExpiresAt) <= Date.now()) {
      await journal.uncertain(operationId, 'lease_lost');
      return;
    }
    const start = await journal.begin(operationId);
    try {
      const permission = RuntimeBridgeStartResponseSchema.parse(
        await bridgeRequest({
          server: config.server,
          path: `${runtimeBridgeOperationPath}/${operationId}/start`,
          method: 'POST',
          token,
          body: {
            contractVersion: 1,
            receiptId: start.receiptId,
            attempt: dispatch.snapshot.binding.attempt,
            leaseToken: dispatch.leaseToken,
          },
          maximumResponseBytes: 200_000,
        }),
      );
      if (
        !permission.mayExecute ||
        permission.snapshot.status !== 'running' ||
        permission.snapshot.cancelRequestId !== null ||
        !runtimeContractEqual(
          permission.snapshot.binding,
          dispatch.snapshot.binding,
        ) ||
        Date.parse(dispatch.leaseExpiresAt) <= Date.now()
      ) {
        await journal.uncertain(operationId, 'lease_lost');
        return;
      }
    } catch {
      // A start response can be lost AFTER the server recorded started. There
      // is no safe reason to repeat start or execute after this ambiguity.
      await journal.uncertain(operationId, 'connection_lost');
      return;
    }
    let result: Awaited<ReturnType<typeof executeLocalCommand>>;
    try {
      result = await (this.input.execute ?? executeLocalCommand)(
        root,
        dispatch.payload,
      );
    } catch {
      // Existing write helpers can throw after a rename/mkdir. They cannot
      // prove that no effect occurred, so do not fabricate a failed/none result.
      await journal.uncertain(operationId, 'receipt_missing');
      return;
    }
    try {
      await journal.outcome(operationId, {
        status: 'succeeded',
        effects: ['local.fs.write', 'local.fs.mkdir'].includes(
          dispatch.payload.capability,
        )
          ? 'applied'
          : 'none',
        output: result.output,
        summary: result.summary,
      });
    } catch (error) {
      // Oversized output is omitted rather than turning a completed write into
      // failed. Durable evidence still reports the actual known effect.
      if (
        !(error instanceof BridgeJournalError) ||
        error.code !== 'JOURNAL_RESULT_TOO_LARGE'
      )
        throw error;
      await journal.outcome(operationId, {
        status: 'succeeded',
        effects: ['local.fs.write', 'local.fs.mkdir'].includes(
          dispatch.payload.capability,
        )
          ? 'applied'
          : 'none',
        summary:
          'Operation completed; output exceeded the journal limit and was omitted',
        output: { truncated: true, reason: 'output_limit' },
      });
    }
  }
}
