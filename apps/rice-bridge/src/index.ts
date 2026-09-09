#!/usr/bin/env node
import {
  grant,
  help,
  launch,
  pair,
  revoke,
  sandbox,
  start,
  status,
} from './core.js';
import { BridgeInstanceLock } from './instance-lock.js';
import { bridgeVersion } from './version.js';

async function main() {
  const [requestedCommand, ...args] = process.argv.slice(2);
  const command = requestedCommand ?? 'launch';
  if (command === '--version' || command === 'version')
    return console.info(bridgeVersion);
  if (command === 'status') return status();
  if (command === 'local-mcp' && args.length === 1 && args[0] === 'status')
    return (await import('./local-mcp-settings.js')).localMcpSettingsCli(args);
  if (
    command === 'local-mcp' &&
    (args.length === 0 || (args.length === 1 && args[0] === '--help'))
  )
    return (
      await import('./local-mcp-credentials.js')
    ).localMcpCredentialHelp();
  // This opt-in can be changed while the menu-bar instance is running; its
  // controller reads the device/server-bound private setting before every I/O.
  if (command === 'browser')
    return (await import('./local-browser-settings.js')).localBrowserCli(args);
  if (command === 'preview')
    return (await import('./local-preview-cli.js')).localPreviewCli(args);
  if (command === 'sandbox' && (args[0] ?? 'status') === 'status')
    return sandbox(args);
  if (
    ![
      'launch',
      'pair',
      'grant',
      'start',
      'sandbox',
      'revoke',
      'desktop',
      'local-mcp',
    ].includes(command)
  )
    return help();
  const lock = await BridgeInstanceLock.acquire();
  try {
    if (command === 'desktop')
      await (await import('./desktop-controller.js')).runDesktopController();
    else if (command === 'launch') await launch();
    else if (command === 'pair') await pair(args);
    else if (command === 'grant') await grant(args);
    else if (command === 'start') await start();
    else if (command === 'sandbox') await sandbox(args);
    else if (command === 'revoke') await revoke();
    else if (command === 'local-mcp') {
      if (['enable', 'disable'].includes(args[0] ?? ''))
        await (
          await import('./local-mcp-settings.js')
        ).localMcpSettingsCli(args);
      else
        await (
          await import('./local-mcp-credentials.js')
        ).localMcpCredentialCli(args);
    }
  } finally {
    lock.close();
  }
}

void main().catch((error: unknown) => {
  if (process.argv[2] === 'desktop') {
    console.error('BRIDGE_DESKTOP_START_FAILED');
    process.stdout.write(
      JSON.stringify({
        v: 1,
        type: 'fatal',
        code:
          error instanceof Error && error.message === 'BRIDGE_ALREADY_RUNNING'
            ? 'BRIDGE_ALREADY_RUNNING'
            : 'BRIDGE_START_FAILED',
      }) + '\n',
    );
  } else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
