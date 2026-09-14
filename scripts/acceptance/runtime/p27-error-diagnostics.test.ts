import { describe, expect, it } from 'vitest';
import { HandlerError } from '../../../apps/worker/src/errors.ts';
import { p27ErrorDiagnostics } from './p27-error-diagnostics.ts';

const secret = 'synthetic-secret-never-a-real-credential';
function first(error: unknown) {
  return p27ErrorDiagnostics(error).errors[0]!;
}
describe('P27 bounded safe error diagnostics (no provider)', () => {
  it('keeps actual HandlerError metadata, never its message/stack/provider payload', () => {
    const error = new HandlerError(
      'DSH_REQUEST_FAILED',
      `HTTP 400: budget_exhausted; Authorization: Bearer ${secret}`,
      false,
    );
    const proof = p27ErrorDiagnostics(error);
    expect(proof.errors[0]).toMatchObject({
      class: 'HandlerError',
      code: 'DSH_REQUEST_FAILED',
      retryable: false,
      httpStatus: 400,
      categories: ['budget'],
    });
    expect(JSON.stringify(proof)).not.toContain(secret);
    expect(proof.errors[0]).not.toHaveProperty('message');
    expect(proof.errors[0]).not.toHaveProperty('stack');
  });
  it.each([
    ['authentication', 'Authentication failed: invalid_api_key'],
    ['authentication', 'DSH_CREDENTIAL_UNAVAILABLE'],
    ['authentication', 'CODEX_SUBSCRIPTION_AUTH_REQUIRED'],
    ['rate_limit', 'rate_limit_exceeded: too many requests'],
    ['model_unavailable', 'The model does not exist or is not available'],
    ['strict_tool_schema', 'Invalid schema for function assistant_report'],
    ['strict_tool_schema', 'additionalProperties is required to be false'],
    ['previous_response_state', 'previous_response_id was not found'],
    ['native_authority', 'assistant_identity_denied'],
    ['native_authority', 'lease_lost'],
    ['budget', 'budget_exhausted'],
    ['timeout', 'DSH_REQUEST_TIMEOUT'],
    ['runtime_protocol', 'DSH_PROTOCOL_MISMATCH'],
    ['execution_aborted', 'EXECUTION_ABORTED'],
  ])('classifies %s without copying any matched text', (category, message) => {
    const proof = first(new Error(`${message}: ${secret}`));
    expect(proof.categories).toContain(category);
    expect(JSON.stringify(proof)).not.toContain(secret);
    expect(proof.code).toBeNull();
  });
  it('preserves exact source-defined assertion/runtime codes, not plausible prefixes', () => {
    expect(first(Error('p27_execute_deadline')).code).toBe(
      'p27_execute_deadline',
    );
    expect(first({ code: 'budget_exhausted' }).code).toBe('budget_exhausted');
    for (const code of [
      'p27_lowercasesecretpayload',
      `DSH_${secret}`,
      secret,
    ]) {
      const proof = p27ErrorDiagnostics({ code, message: code, name: code });
      expect(proof.errors[0]).toMatchObject({
        code: null,
        class: 'UnknownError',
      });
      expect(JSON.stringify(proof)).not.toContain(code);
    }
  });
  it('reads only numeric bounded HTTP statuses and boolean retryable metadata', () => {
    expect(first({ statusCode: 429, retryable: true })).toMatchObject({
      httpStatus: 429,
      retryable: true,
      categories: ['rate_limit'],
    });
    expect(
      first({
        response: {
          status: 401,
          headers: { authorization: secret },
          body: secret,
        },
      }),
    ).toMatchObject({
      httpStatus: 401,
      categories: ['authentication'],
    });
    for (const status of [-1, 200, 600, NaN, Infinity, '429', secret]) {
      expect(first({ status, retryable: secret })).toMatchObject({
        httpStatus: null,
        retryable: null,
      });
    }
    expect(first(Error(`statusCode: 503 ${secret}`)).httpStatus).toBe(503);
    expect(first(Error(`"status": 400 ${secret}`)).httpStatus).toBe(400);
  });
  it('captures a bounded cause chain including a native budget code but no raw cause', () => {
    const proof = p27ErrorDiagnostics(
      new Error(secret, {
        cause: Object.assign(new Error('budget_exhausted'), {
          code: 'budget_exhausted',
          retryable: false,
        }),
      }),
    );
    expect(proof.errors).toHaveLength(2);
    expect(proof.errors[1]).toMatchObject({
      depth: 1,
      code: 'budget_exhausted',
      categories: ['budget'],
    });
    expect(JSON.stringify(proof)).not.toContain(secret);
  });
  it('limits deep or cyclic cause graphs without traversing arbitrary errors/payload trees', () => {
    let error: unknown = { message: secret };
    for (let index = 0; index < 100; index++)
      error = { message: secret, cause: error };
    const proof = p27ErrorDiagnostics(error);
    expect(proof.errors).toHaveLength(5);
    expect(proof.causeChainTruncated).toBe(true);
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(p27ErrorDiagnostics(cycle)).toMatchObject({
      causeCycleDetected: true,
    });
    expect(
      p27ErrorDiagnostics({ errors: [error], payload: error }).errors,
    ).toHaveLength(1);
  });
  it('never invokes getters, serialization hooks, or object stringification', () => {
    let invoked = 0;
    const error = Object.create(null);
    for (const key of [
      'code',
      'message',
      'cause',
      'name',
      'retryable',
      'status',
      'statusCode',
      'httpStatus',
      'response',
    ]) {
      Object.defineProperty(error, key, {
        get() {
          invoked++;
          throw Error(secret);
        },
      });
    }
    error.toJSON = error.toString = () => {
      invoked++;
      throw Error(secret);
    };
    expect(() => JSON.stringify(p27ErrorDiagnostics(error))).not.toThrow();
    expect(invoked).toBe(0);
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    expect(first(proxy.proxy).class).toBe('UnknownError');
    const liveProxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          invoked++;
          throw Error(secret);
        },
        getPrototypeOf() {
          invoked++;
          throw Error(secret);
        },
        get() {
          invoked++;
          throw Error(secret);
        },
      },
    );
    expect(first(liveProxy)).toMatchObject({
      class: 'UnknownError',
      code: null,
    });
    expect(invoked).toBe(0);
  });
  it('bounds scans and output for arbitrarily long sensitive payloads', () => {
    const message = secret.repeat(100000) + ' budget_exhausted HTTP 429';
    const proof = p27ErrorDiagnostics({
      message,
      code: message,
      name: message,
      stack: message,
      headers: { authorization: message },
      request: { body: message },
    });
    expect(proof.errors[0]).toMatchObject({
      class: 'UnknownError',
      code: null,
      httpStatus: null,
      categories: ['unknown'],
      scanTruncated: true,
    });
    const serialized = JSON.stringify(proof);
    expect(serialized.length).toBeLessThan(1000);
    expect(serialized).not.toContain(secret);
  });
  it.each([undefined, null, 42, true, Symbol(secret)])(
    'handles non-error throws without copying them',
    (error) => {
      expect(first(error)).toMatchObject({
        class: 'UnknownError',
        code: null,
        categories: ['unknown'],
      });
      expect(JSON.stringify(p27ErrorDiagnostics(error))).not.toContain(secret);
    },
  );
});
