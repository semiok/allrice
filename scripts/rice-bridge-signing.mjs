import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function bridgeSigningConfiguration(environment = process.env) {
  const mode = environment.ALLRICE_BRIDGE_SIGNING_MODE ?? 'development';
  if (mode === 'development') return { mode };
  if (mode !== 'developer-id') throw Error('BRIDGE_SIGNING_MODE_INVALID');
  const identity = environment.ALLRICE_BRIDGE_SIGNING_IDENTITY;
  const teamId = environment.ALLRICE_BRIDGE_SIGNING_TEAM_ID;
  const profile = environment.ALLRICE_BRIDGE_NOTARY_PROFILE;
  if (
    !/^[a-fA-F0-9]{40}$/.test(identity ?? '') ||
    !/^[A-Z0-9]{10}$/.test(teamId ?? '') ||
    !/^[a-zA-Z0-9._-]{1,80}$/.test(profile ?? '')
  )
    throw Error('BRIDGE_SIGNING_CONFIGURATION_REQUIRED');
  // Identifiers only. No certificate/private-key export, account lookup,
  // password argv, Keychain unlock, ACL changes or implicit fallback.
  return { mode, identity, teamId, profile };
}

function command(program, args, timeout = 30000) {
  try {
    return execFileSync(program, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: 65536,
    });
  } catch {
    throw Error('BRIDGE_SIGNING_STEP_FAILED');
  }
}

export function assertBridgeSigningAvailable(config, run = command) {
  if (config.mode === 'development') return;
  const identities = run('/usr/bin/security', [
    'find-identity',
    '-v',
    '-p',
    'codesigning',
  ]);
  const found = identities
    .split('\n')
    .some(
      (line) =>
        line.includes(config.identity) &&
        line.includes('Developer ID Application:') &&
        line.includes(`(${config.teamId})`),
    );
  if (!found) throw Error('BRIDGE_DEVELOPER_ID_UNAVAILABLE');
}

/** Inside-out signing, Apple ticket validation and Gatekeeper; only a newly
 * built output App is accepted by the calling package builder. */
export function signAndNotarizeBridge(config, app, output, run = command) {
  if (config.mode !== 'developer-id')
    throw Error('BRIDGE_SIGNING_CONFIGURATION_REQUIRED');
  const core = join(app, 'Contents/Resources/RiceBridgeCore');
  for (const binary of [
    core,
    join(app, 'Contents/MacOS/RiceBrowserLauncher'),
    join(app, 'Contents/MacOS/RiceBridgeApp'),
  ]) {
    run('/usr/bin/codesign', [
      '--force',
      '--sign',
      config.identity,
      '--timestamp',
      '--options',
      'runtime',
      ...(binary === core
        ? ['--entitlements', 'apps/rice-bridge/macos/Core.entitlements.plist']
        : []),
      binary,
    ]);
  }
  run('/usr/bin/codesign', [
    '--force',
    '--sign',
    config.identity,
    '--timestamp',
    '--options',
    'runtime',
    app,
  ]);
  const requirement = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${config.teamId}" and identifier "xyz.bplabs.rice-bridge"`;
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    requirement,
    app,
  ]);
  const submission = join(output, 'notary-submission.zip');
  run('/usr/bin/ditto', [
    '-c',
    '-k',
    '--keepParent',
    '--norsrc',
    app,
    submission,
  ]);
  const result = JSON.parse(
    run(
      '/usr/bin/xcrun',
      [
        'notarytool',
        'submit',
        submission,
        '--keychain-profile',
        config.profile,
        '--wait',
        '--output-format',
        'json',
      ],
      600000,
    ),
  );
  if (result.status !== 'Accepted')
    throw Error('BRIDGE_NOTARIZATION_NOT_ACCEPTED');
  run('/usr/bin/xcrun', ['stapler', 'staple', app]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    requirement,
    app,
  ]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  // Caller must ZIP again AFTER stapling and sign metadata for those final bytes.
  return {
    signing: 'developer-id',
    notarization: 'accepted-and-stapled',
    teamId: config.teamId,
  };
}

/** Run against the App re-extracted from FINAL distribution bytes too. */
export function verifyPackagedBridge(config, app, run = command) {
  if (config.mode !== 'developer-id')
    throw Error('BRIDGE_SIGNING_CONFIGURATION_REQUIRED');
  const requirement = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${config.teamId}" and identifier "xyz.bplabs.rice-bridge"`;
  run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R',
    requirement,
    app,
  ]);
  run('/usr/bin/xcrun', ['stapler', 'validate', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
}
