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

const compoundCredentialLabels = [
  'Authorization',
  'providerAuthorization',
  'API_KEY',
  'providerApiKey',
  'access_token',
  'providerAccessToken',
  'refresh-token',
  'providerRefreshToken',
  'password',
  'providerPassword',
  'secret',
  'providerSecret',
  'cookie',
  'providerCookie',
  'client_secret',
  'CLIENT_SECRET',
  'client-secret',
  'clientSecret',
  'provider_client_secret',
  'PROVIDER_CLIENT_SECRET',
  'provider-client-secret',
  'providerClientSecret',
  'auth_token',
  'AUTH_TOKEN',
  'auth-token',
  'authToken',
  'provider_auth_token',
  'PROVIDER_AUTH_TOKEN',
  'provider-auth-token',
  'providerAuthToken',
  'id_token',
  'ID_TOKEN',
  'id-token',
  'idToken',
  'provider_id_token',
  'PROVIDER_ID_TOKEN',
  'provider-id-token',
  'providerIdToken',
  'private_key',
  'PRIVATE_KEY',
  'private-key',
  'privateKey',
  'provider_private_key',
  'PROVIDER_PRIVATE_KEY',
  'provider-private-key',
  'providerPrivateKey',
];

describe('synthetic provider failures; historical observations only cover auth/service', () => {
  it.each([
    ['AUTH', 'auth'],
    ['INVALID_CREDENTIAL', 'auth'],
    ['MISSING_CREDENTIAL', 'auth'],
    ['QUOTA', 'quota'],
    ['ACCOUNT_QUOTA', 'quota'],
    ['RATE_LIMIT', 'rate_limit'],
    ['SERVER', 'service'],
    ['TRANSPORT', 'transport'],
    ['TIMEOUT', 'transport'],
    ['STREAM_CLOSED', 'transport'],
    ['CONTEXT_WINDOW_EXCEEDED', 'context'],
  ] as const)(
    'uses the explicit rc.2 %s code before conflicting message/status evidence',
    (code, category) => {
      expect(
        classifyModelFailure('Unclassified provider receipt', undefined, code),
      ).toBe(category);
      expect(
        classifyModelFailure(
          'Your authentication token has expired',
          401,
          code,
        ),
      ).toBe(category);
      expect(classifyModelFailure('Too many requests', 429, code)).toBe(
        category,
      );
    },
  );
  it('classifies the native pi-ai overflow receipt and preserves historical source proof', () => {
    for (const message of [
      'pi-ai detected context overflow',
      'pi-ai detected context overflow for model "synthetic"',
    ])
      expect(modelFailure(message).category).toBe('context');
    expect(
      modelFailure('Notes about pi-ai detected context overflow handling')
        .category,
    ).toBe('unknown');
    expect(
      modelFailure(
        'pi-ai detected context overflow for model "synthetic"',
        undefined,
        'CONTEXT_WINDOW_EXCEEDED',
      ).category,
    ).toBe('context');
    for (const code of ['DSH_MISSING_CREDENTIAL', 'DSH_STREAM_CLOSED'])
      expect(isModelFailureCode(code)).toBe(false);
  });
  it.each([
    'EMPTY_RESPONSE',
    'INVALID_RESPONSE',
    'MALFORMED_RESPONSE',
    'INVALID_REQUEST',
    'IMAGE_OFFLOAD_REQUIRED',
    'ABORTED',
    'PI_AI_ERROR',
    'UNKNOWN',
    'FILES_API',
    'HTTP_404',
    'REQUEST_EXTENSION',
    'INVALID_REPLAY_STATE',
    'UNSUPPORTED_CONTENT',
    'UNSUPPORTED_OPTION',
    'UNSUPPORTED_REASONING_EFFORT',
    'UNKNOWN_MODEL',
    'INVALID_CONFIG',
    'NO_ADAPTER',
    'NO_CREDENTIAL_STORE',
    'UNSTORABLE_PROVIDER_ID',
    'DISCOVERY_FAILED',
    'DISCOVERY_UNSUPPORTED',
    'NO_DISCOVERY',
    'INVALID_ADAPTER',
    'DUPLICATE_ADAPTER',
    'REGISTRATION_DISPOSED',
    'INVALID_DIRECTORY',
    'DUPLICATE_DIRECTORY',
    'INVALID_DISCOVERY',
    'DUPLICATE_DISCOVERY',
    'INVALID_CATALOG',
    'INVALID_MODEL_INFO',
    'INVALID_MODEL_CONTEXT',
    'INVALID_MODEL_MAX_TOKENS',
    'INVALID_MODEL_REASONING',
    'INVALID_PREPARED_CALL',
  ])('does not guess a cause from the non-specific rc.2 code %s', (code) => {
    expect(
      classifyModelFailure('Unclassified provider receipt', undefined, code),
    ).toBe('unknown');
  });
  it.each(compoundCredentialLabels)(
    'replaces the bounded credential value for %s and fails closed if a replacement leaves it behind',
    (label) => {
      const sensitiveValue = 'SyntheticCredentialValueQWER';
      for (const input of [
        `Provider failure. ${label}=${sensitiveValue}`,
        `Provider failure. ${label}: '${sensitiveValue}'`,
        `Provider failure. {"${label}":"${sensitiveValue}"}`,
      ]) {
        const output = redactModelFailure(input);
        expect(output).toContain('Provider failure.');
        expect(output).toContain('[已隐藏]');
        expect(output).not.toContain(sensitiveValue);
        const replace = vi
          .spyOn(String.prototype, 'replace')
          .mockImplementation(function (this: string) {
            return String(this);
          });
        try {
          expect(redactModelFailure(input)).toBe(hiddenModelFailure);
        } finally {
          replace.mockRestore();
        }
      }
    },
  );
  it.each(compoundCredentialLabels)(
    'hides the whole credential receipt when %s has no reliable boundary',
    (label) => {
      for (const input of [
        `${label} SyntheticCredentialValueQWER`,
        `Incorrect ${label} provided: SyntheticCredentialValueQWER`,
        `${label}\nSyntheticCredentialValueQWER`,
        `{"${label}\\u0022":"SyntheticCredentialValueQWER"}`,
        `{"${label}\\n":"SyntheticCredentialValueQWER"}`,
      ])
        expect(redactModelFailure(input)).toBe(hiddenModelFailure);
    },
  );
  it.each([
    '用了多少 token',
    'input_tokens=120 output_tokens=60 total_tokens=180 token_usage=180 token_limit=200000',
    'tokenUsage: 180; tokenLimit: 200000; usedTokenCount: 180; validTokenCount: 180; valid_tokens: 180',
    'maxTokens=16000; outputTokenLimit=16000',
    'Your authentication token has expired',
    'The secretary confirmed the request',
    'The secretion measurement is available',
    'The Secretarial report is available',
  ])(
    'keeps ordinary token statistics and the monitor expiry receipt readable: %s',
    (message) => {
      expect(redactModelFailure(message)).toBe(message);
    },
  );
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

  it.each([
    'Token usage information is unavailable',
    'Model output token limit exceeded',
  ])('preserves ordinary token nouns: %s', (text) => {
    expect(redactModelFailure(text)).toBe(text);
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
