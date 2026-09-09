import { describe, expect, it } from 'vitest';
import {
  desktopSafeError,
  desktopSafeText,
  parseDesktopRequest,
} from './desktop-protocol.js';
import { journalDirectory } from './core.js';

const parse = (value: unknown) => parseDesktopRequest(JSON.stringify(value));
const base = { v: 1, id: 'request-1' };
describe('P13 private desktop control protocol', () => {
  it.each(['status', 'pause', 'resume', 'diagnostics', 'stop'])(
    'accepts finite %s requests',
    (type) => expect(parse({ ...base, type })).toEqual({ ...base, type }),
  );
  it.each([
    { type: 'execute', command: 'rm -rf /' },
    { type: 'pause', shell: 'echo hello' },
    { type: '__proto__' },
    { type: 'status', v: 2 },
    { type: 'status', id: '\nsecret' },
    { type: 'workspace', path: 'relative' },
    { type: 'workspace', path: '/tmp/a\nsecret' },
    { type: 'picker', pickerId: 'bad\n', path: null },
    { type: 'revoke', confirmDeviceId: 'not-the-device' },
    { type: 'browser', enabled: 'true' },
    { type: 'browser', enabled: true, executable: '/bin/sh' },
    { type: 'browser' },
  ])('denies invalid/extra control fields: %j', (value) =>
    expect(() => parse({ ...base, ...value })).toThrow(),
  );
  it.each([true, false])(
    'accepts only the explicit finite browser opt-in %s',
    (enabled) => {
      expect(parse({ ...base, type: 'browser', enabled })).toEqual({
        ...base,
        type: 'browser',
        enabled,
      });
    },
  );
  it.each([
    'http://tenant.example/',
    'https://user:secret@tenant.example/',
    'https://tenant.example/?key=secret',
    'https://tenant.example/path',
  ])('denies unsafe pairing origin %s', (server) =>
    expect(() =>
      parse({ ...base, type: 'pair', server, code: 'A1B2-C3D4' }),
    ).toThrow(),
  );
  it.each(['A1B2C3D4', 'a1b2-c3d4'])(
    'accepts code with or without hyphen: %s',
    (code) =>
      expect(
        parse({
          ...base,
          type: 'pair',
          server: 'https://tenant.example/',
          code,
        }).type,
      ).toBe('pair'),
  );
  it('bounds frames and never exports arbitrary remote error text', () => {
    expect(() => parseDesktopRequest(' '.repeat(20_000))).toThrow(
      'DESKTOP_FRAME_LIMIT',
    );
    expect(desktopSafeError(Error('Authorization: Bearer super-secret'))).toBe(
      'BRIDGE_ACTION_FAILED',
    );
    expect(desktopSafeText('name\n\u0000tail')).toBe('name  tail');
  });
  it('keeps old journal path and isolates new identities without deleting evidence', () => {
    const config = {
      server: 'https://tenant.example/',
      deviceId: '00000000-0000-4000-8000-000000000011',
      deviceName: 'test',
      grants: [],
    };
    expect(journalDirectory(config)).toMatch(/config.json.operation-journal$/);
    expect(
      journalDirectory({ ...config, journalNamespace: config.deviceId }),
    ).toMatch(new RegExp(`operation-journal-${config.deviceId}$`));
    expect(() =>
      journalDirectory({ ...config, journalNamespace: '../old' }),
    ).toThrow('JOURNAL_NAMESPACE_INVALID');
  });
});
