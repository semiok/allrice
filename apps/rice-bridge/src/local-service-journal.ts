import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BridgeJournalError } from './journal-error.js';
import {
  RuntimeLocalServiceEventSchema,
  RuntimeLocalServiceInputSchema,
  RuntimeBridgeDispatchSchema,
  canonicalRuntimeBridgeJson,
  type RuntimeLocalServiceEvent,
  type RuntimeLocalServiceInput,
} from '@allrice/contracts';

/** Uses the existing Bridge SQLite transaction/OS owner lock. Not a second
 * execution authority. Only bounded lifecycle evidence and input effect intents. */
export class LocalServiceJournal {
  constructor(
    private readonly db: DatabaseSync,
    private readonly access: <T>(id: string, action: () => T) => Promise<T>,
  ) {}

  static initialize(db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS service_events (
        operation_id TEXT NOT NULL REFERENCES entries(operation_id),
        sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 63),
        body TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(operation_id,sequence));
      CREATE TABLE IF NOT EXISTS service_inputs (
        operation_id TEXT NOT NULL REFERENCES entries(operation_id),
        request_id TEXT NOT NULL, input_id TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','delivered')),
        PRIMARY KEY(operation_id,request_id));
    `);
  }

  async event(id: string, input: RuntimeLocalServiceEvent) {
    const event = RuntimeLocalServiceEventSchema.parse(input);
    if (event.processId !== id)
      throw new BridgeJournalError('SERVICE_JOURNAL_IDENTITY');
    return this.access(id, () => {
      const owned = this.db
        .prepare('SELECT dispatch FROM entries WHERE operation_id=?')
        .get(id);
      const dispatch = RuntimeBridgeDispatchSchema.parse(
        JSON.parse(String(owned?.dispatch)),
      );
      if (event.attemptId !== dispatch.snapshot.binding.attempt.attemptId)
        throw new BridgeJournalError('SERVICE_JOURNAL_ATTEMPT');
      const body = canonicalRuntimeBridgeJson(event);
      const prior = this.db
        .prepare(
          'SELECT body FROM service_events WHERE operation_id=? AND sequence=?',
        )
        .get(id, event.sequence);
      if (prior) {
        if (prior.body !== body)
          throw new BridgeJournalError('SERVICE_EVENT_CONFLICT');
        return;
      }
      const count = Number(
        this.db
          .prepare(
            'SELECT count(*) AS n FROM service_events WHERE operation_id=?',
          )
          .get(id)?.n,
      );
      if (count !== event.sequence)
        throw new BridgeJournalError('SERVICE_EVENT_SEQUENCE');
      if (event.type === 'input_delivered') {
        const row = this.db
          .prepare(
            'SELECT body FROM service_inputs WHERE operation_id=? AND input_id=?',
          )
          .get(id, event.inputId);
        if (!row) throw new BridgeJournalError('SERVICE_INPUT_UNPREPARED');
        const saved = RuntimeLocalServiceInputSchema.parse(
          JSON.parse(String(row.body)),
        );
        if (
          saved.requestId !== event.requestId ||
          saved.sequence !== event.inputSequence ||
          saved.digest !== event.digest ||
          saved.kind !== event.kind
        )
          throw new BridgeJournalError('SERVICE_INPUT_CONFLICT');
        this.db
          .prepare(
            "UPDATE service_inputs SET state='delivered' WHERE operation_id=? AND input_id=?",
          )
          .run(id, event.inputId);
      }
      this.db
        .prepare(
          'INSERT INTO service_events(operation_id,sequence,body) VALUES(?,?,?)',
        )
        .run(id, event.sequence, body);
    });
  }

  async pending(id: string) {
    return this.access(id, () =>
      this.db
        .prepare(
          'SELECT body FROM service_events WHERE operation_id=? AND acknowledged=0 ORDER BY sequence LIMIT 16',
        )
        .all(id)
        .map((row) =>
          RuntimeLocalServiceEventSchema.parse(JSON.parse(String(row.body))),
        ),
    );
  }

  async acknowledge(id: string, sequence: number) {
    if (!Number.isInteger(sequence) || sequence < -1 || sequence > 63)
      throw new BridgeJournalError('SERVICE_ACK_INVALID');
    await this.access(id, () => {
      const max = Number(
        this.db
          .prepare(
            'SELECT coalesce(max(sequence),-1) AS n FROM service_events WHERE operation_id=?',
          )
          .get(id)?.n,
      );
      if (sequence > max) throw new BridgeJournalError('SERVICE_ACK_INVALID');
      this.db
        .prepare(
          'UPDATE service_events SET acknowledged=1 WHERE operation_id=? AND sequence<=?',
        )
        .run(id, sequence);
    });
  }

  /** First acceptance durably precedes writing the pipe. A prepared duplicate
   * means unknown effect; it is NEVER another permission to write. */
  async prepare(
    id: string,
    value: RuntimeLocalServiceInput,
  ): Promise<'new' | 'delivered'> {
    const input = RuntimeLocalServiceInputSchema.parse(value);
    const digest =
      'sha256:' +
      createHash('sha256')
        .update(
          canonicalRuntimeBridgeJson({ kind: input.kind, text: input.text }),
        )
        .digest('hex');
    if (input.digest !== digest)
      throw new BridgeJournalError('SERVICE_INPUT_DIGEST');
    return this.access(id, () => {
      const body = canonicalRuntimeBridgeJson(input);
      const prior = this.db
        .prepare(
          'SELECT body,state FROM service_inputs WHERE operation_id=? AND request_id=?',
        )
        .get(id, input.requestId);
      if (prior) {
        if (prior.body !== body)
          throw new BridgeJournalError('SERVICE_INPUT_CONFLICT');
        if (prior.state !== 'delivered')
          throw new BridgeJournalError('SERVICE_INPUT_EFFECT_UNKNOWN');
        return 'delivered';
      }
      const requestRows = this.db
        .prepare(
          "SELECT body FROM service_events WHERE operation_id=? AND json_extract(body,'$.type')='input_request'",
        )
        .all(id);
      const event = requestRows
        .map((row) =>
          RuntimeLocalServiceEventSchema.parse(JSON.parse(String(row.body))),
        )
        .find(
          (e) =>
            e.type === 'input_request' &&
            e.request.requestId === input.requestId,
        );
      const count = Number(
        this.db
          .prepare(
            'SELECT count(*) AS n FROM service_inputs WHERE operation_id=?',
          )
          .get(id)?.n,
      );
      if (
        !event ||
        event.type !== 'input_request' ||
        event.request.sequence !== input.sequence ||
        input.sequence !== count ||
        event.request.expiresAt !== input.expiresAt ||
        Date.parse(input.expiresAt) <= Date.now() ||
        Buffer.byteLength(input.text) > event.request.maxBytes ||
        count >= 16
      )
        throw new BridgeJournalError('SERVICE_INPUT_REQUEST_MISMATCH');
      this.db
        .prepare("INSERT INTO service_inputs VALUES(?,?,?,?,'prepared')")
        .run(id, input.requestId, input.inputId, body);
      return 'new';
    });
  }
}
