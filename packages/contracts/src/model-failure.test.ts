import { describe, expect, it, vi } from 'vitest';
import {
  classifyModelFailure,
  hiddenModelFailure,
  isModelFailureCode,
  modelFailure,
  modelFailureText,
  publicModelFailureMessage,
  publicModelFailureMetadata,
  readModelFailure,
  redactModelFailure,
} from './model-failure.ts';

describe('synthetic provider failures; historical observations only cover auth/service', () => {
  it.each([
    ['Your authentication token has expired', undefined, 'auth'],
    [
      'Codex error: Our servers are currently overloaded. Please try again later.',
      undefined,
      'service',
    ],
    ['Account quota exhausted', 429, 'quota'],
    ['You exceeded your current quota', 429, 'quota'],
    ['Too many requests', 429, 'rate_limit'],
    ['Connection reset by peer', undefined, 'transport'],
    ['Maximum context length exceeded', undefined, 'context'],
    ['Unrecognized provider failure', undefined, 'unknown'],
    ['Unauthorized', 401, 'auth'],
    ['Unavailable', 503, 'service'],
    ['Large request', 413, 'context'],
  ] as const)('classifies explicit facts: %s', (message, status, category) => {
    expect(modelFailure(message, status).category).toBe(category);
    expect(modelFailureText(category, 'run-reference')).toContain(
      '错误编号：run-reference',
    );
  });

  it.each([
    ['Policy rejected this request', 403],
    ['Network configuration', undefined],
    ['Connection settings available', undefined],
    ['The context window is 200000', undefined],
    ['Context length supported', undefined],
    ['Authentication configuration', undefined],
    ['Quota report', undefined],
    ['Unexpected response', 400],
  ] as const)(
    'does not infer a cause from an incidental noun: %s',
    (text, status) => {
      expect(classifyModelFailure(text, status)).toBe('unknown');
    },
  );

  it('classifies before redacting and keeps the fixed expired original readable', () => {
    const text = 'Your authentication token has expired';
    expect(modelFailure(text)).toEqual({
      category: 'auth',
      upstreamMessage: text,
    });
    expect(modelFailure(text + ' https://private.test/path')).toMatchObject({
      category: 'auth',
      upstreamMessage: text + ' [已隐藏]',
    });
    for (const category of ['auth', 'quota'] as const) {
      expect(modelFailureText(category)).toContain('反复重试无法');
      expect(modelFailureText(category)).toContain('管理员');
      expect(modelFailureText(category)).not.toContain('员工');
    }
    expect(modelFailureText('unknown', 'run-reference')).toContain(
      '模型服务返回了未归类的错误',
    );
  });

  it('removes sensitive URL, credential, mail, path and identifier forms', () => {
    const secrets = [
      'https://private.test/path?q=secret',
      'help.private.test',
      'Bearer short-secret',
      'Authorization: Basic cHJpdmF0ZTpwYXNz',
      'Basic cHJpdmF0ZTpwYXNz',
      'sk-private',
      'eyJhbGci.eyJzdWI.signature',
      'person@example.test',
      '人名@内部.example',
      '/Users/private/file.txt',
      '~/private/file',
      '../private/file',
      './private/file',
      'C:\\Users\\private\\file.txt',
      '\\\\server\\share\\file',
      'relative/private/file',
      '12345678-1234-4123-8123-123456789abc',
      'req_private',
      'Request ID abc-123',
      'request-id abc123',
      'Trace ID abcxyz',
      '.env',
      '%APPDATA%\\private\\file',
      'request_id=opaque',
      'api_key=private-value',
      'token: private-token',
      'password=private-password',
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      '0123456789abcdef0123456789abcdef',
      '-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----',
    ];
    for (const secret of secrets) {
      const failure = modelFailure(
        'Your authentication token has expired ' + secret,
      );
      expect(failure.category).toBe('auth');
      expect(failure.upstreamMessage, secret).not.toContain(secret);
    }
    expect(
      redactModelFailure('Authorization: Basic cHJpdmF0ZTpwYXNz'),
    ).not.toContain('cHJpdmF0ZTpwYXNz');
    expect(
      redactModelFailure('Provider failure details repeated. '.repeat(5000)),
    ).toHaveLength(1000);
  });

  it('fails closed for invalid input, obfuscated controls, residual credentials and redaction exceptions', () => {
    for (const invalid of [
      null,
      {},
      Symbol('private'),
      '',
      'private\u0000value',
      'Bearer\u200b hidden',
      'sk-',
    ])
      expect(redactModelFailure(invalid)).toBe(hiddenModelFailure);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw Error('private');
        },
      },
    );
    expect(redactModelFailure(hostile)).toBe(hiddenModelFailure);
    expect(readModelFailure(hostile)).toBeNull();
    const replace = vi
      .spyOn(String.prototype, 'replace')
      .mockImplementationOnce(() => {
        throw Error('private');
      });
    try {
      expect(redactModelFailure('private')).toBe(hiddenModelFailure);
    } finally {
      replace.mockRestore();
    }
    expect(
      readModelFailure({ category: 'auth', upstreamMessage: 'Bearer private' })
        ?.upstreamMessage,
    ).not.toContain('private');
  });

  it('strips the reserved private receipt even inside nested schema-passthrough metadata', () => {
    const business = {
      upstreamMessage: 'Business transport field',
      code: 'CATALOG_NOT_FOUND',
      message: 'Original business message',
      errorMessage: 'Original business message',
    };
    const safe = publicModelFailureMetadata({
      ...business,
      metadata: [
        {
          modelFailure: {
            category: 'auth',
            upstreamMessage: 'PRIVATE',
            nested: { raw: 'PRIVATE' },
          },
          ...business,
        },
      ],
      modelFailure: { category: 'invalid', upstreamMessage: 'PRIVATE' },
    });
    expect(safe).toEqual({
      ...business,
      metadata: [{ modelFailure: { category: 'auth' }, ...business }],
      modelFailure: { category: 'unknown' },
    });
    expect(JSON.stringify(safe)).not.toMatch(/PRIVATE/);
  });

  it('requires model proof for new codes and gives unproven DSH failures a safe outcome-unknown fallback', () => {
    for (const code of [
      'DSH_TURN_FAILED',
      'DSH_UNKNOWN',
      'DSH_NEW_PROVIDER_CODE',
    ]) {
      expect(isModelFailureCode(code)).toBe(false);
      const safe = publicModelFailureMessage(
        code,
        'PRIVATE upstream string',
        'run-reference',
      );
      expect(safe).not.toContain('PRIVATE');
      expect(safe).not.toContain('模型服务返回');
      expect(safe).not.toContain('重试');
      expect(safe).toContain('错误编号：run-reference');
    }
    expect(
      publicModelFailureMessage(
        'DSH_NEW_PROVIDER_CODE',
        'PRIVATE',
        'run-reference',
        { category: 'unknown' },
      ),
    ).toContain('模型服务返回了未归类的错误');
    expect(
      publicModelFailureMessage(
        'CATALOG_NOT_FOUND',
        'Original business message',
      ),
    ).toBe('Original business message');
  });
  it.each([
    'API key: P4ssW0rdQWER123',
    'Invalid API key: P4ssW0rdQWER123',
    'access token: P4ssW0rdQWER123',
    'refresh token = P4ssW0rdQWER123',
  ])('review regression: natural credential label %s is hidden', (text) => {
    expect(redactModelFailure(text)).not.toContain('P4ssW0rdQWER123');
  });
  it.each(
    [
      ['API key', 'API\nkey'],
      ['access token', 'access\ntoken'],
      ['refresh token', 'refresh\ntoken'],
    ].flatMap((labels) =>
      labels.flatMap((label) => [
        `${label} P4ssW0rdQWER123`,
        `Incorrect ${label} provided: P4ssW0rdQWER123`,
        `${label}\nP4ssW0rdQWER123`,
      ]),
    ),
  )('natural credential boundary regression: %s fails closed', (text) => {
    expect(redactModelFailure(text)).toBe(hiddenModelFailure);
  });
  it.each(
    ['Authorization', 'password', 'secret', 'cookie'].flatMap((label) => [
      `${label} P4ssW0rdQWER123`,
      `${label}\nP4ssW0rdQWER123`,
    ]),
  )(
    'natural credential boundary regression: %s has no reliable value boundary',
    (text) => {
      expect(redactModelFailure(text)).toBe(hiddenModelFailure);
    },
  );
  it.each([
    'API key\n:\nP4ssW0rdQWER123',
    'Authorization\n: Bearer\nP4ssW0rdQWER123',
    'Basic\ncHJpdmF0ZTpwYXNz',
    'Bearer\nP4ssW0rdQWER123',
    'api\nkey: P4ssW0rdQWER123',
    'access\ntoken\n= P4ssW0rdQWER123',
    'refresh token\r\n=\r\nP4ssW0rdQWER123',
    'password\n= P4ssW0rdQWER123',
    'secret\r: P4ssW0rdQWER123',
    'cookie \n:\tP4ssW0rdQWER123',
    'token\n: P4ssW0rdQWER123',
    'Basic \r\n cHJpdmF0ZTpwYXNz',
    'Bearer \n P4ssW0rdQWER123',
  ])(
    'second review regression: credential fields spanning lines fail closed: %s',
    (text) => {
      expect(redactModelFailure(text)).toBe(hiddenModelFailure);
    },
  );
  it.each([
    'Authorization: Basic\ncHJpdmF0ZTpwYXNz',
    'Authorization: Bearer\nsynthetic-private',
    'api_key=\nsynthetic-private',
    'token:\n  synthetic-private',
  ])(
    'review regression: unreliable multiline credentials fail closed: %s',
    (text) => {
      expect(redactModelFailure(text)).toBe(hiddenModelFailure);
    },
  );
});
