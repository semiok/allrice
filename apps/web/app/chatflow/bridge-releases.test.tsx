import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { BridgeVersionStatus, compareBridgeVersions } from './bridge-releases';
it.each([
  ['0.6.0-dev.6', '0.6.0-dev.7', -1],
  ['0.6.0-dev.10', '0.6.0-dev.7', 1],
  ['0.6.0', '0.6.0-dev.7', 1],
  ['0.6.0-dev.7', '0.6.0', -1],
  ['0.6.1-dev.1', '0.6.0', 1],
  ['0.6.0-dev.7', '0.6.0-dev.7', 0],
  ['legacy', '0.6.0-dev.7', null],
] as const)(
  'compares %s with %s without suggesting a downgrade',
  (a, b, expected) => expect(compareBridgeVersions(a, b)).toBe(expected),
);
it('distinguishes a last reported version from an online device and avoids an update claim when the package is unavailable', () => {
  const release = {
    platform: 'macos-arm64' as const,
    available: true,
    version: '0.6.0-dev.7',
  };
  const html = renderToStaticMarkup(
    <BridgeVersionStatus
      installed="0.6.0-dev.6"
      release={release}
      online={false}
    />,
  );
  expect(html).toContain('上次上报版本');
  expect(html).toContain('可更新至 v0.6.0-dev.7');
  const unavailable = renderToStaticMarkup(
    <BridgeVersionStatus
      installed="0.6.0-dev.6"
      release={{ ...release, available: false }}
      online
    />,
  );
  expect(unavailable).not.toContain('可更新');
});
