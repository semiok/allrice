import { readConfig } from './config.js';
import { nativeSandboxConfig, sandboxOptIn } from './sandbox-settings.js';
import { localBrowserOptIn } from './local-browser-settings.js';
import {
  localPreviewOptIn,
  saveLocalPreviewOptIn,
} from './local-preview-settings.js';

export async function localPreviewCli(args: string[]) {
  const action = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'enable', 'disable'].includes(action))
    throw Error('preview status|enable|disable');
  const config = await readConfig();
  if (action === 'enable') {
    if (!(await sandboxOptIn(config)) || !(await localBrowserOptIn(config)))
      throw Error('LOCAL_PREVIEW_REQUIRES_BROWSER_AND_SANDBOX');
    const { resolveLocalBrowserExecutable } =
      await import('./local-browser-driver.js');
    const { resolveLocalBrowserLauncher } =
      await import('./local-browser-supervisor.js');
    const { LocalCommandRunner } = await import('./local-command-runner.js');
    await resolveLocalBrowserExecutable();
    await resolveLocalBrowserLauncher();
    await new LocalCommandRunner(nativeSandboxConfig())
      .preflight()
      .catch(() => {
        throw Error('LOCAL_PREVIEW_RUNNER_UNAVAILABLE');
      });
    await saveLocalPreviewOptIn(config, true);
  } else if (action === 'disable') await saveLocalPreviewOptIn(config, false);
  console.info(
    JSON.stringify({
      enabled: await localPreviewOptIn(config),
      requiresBrowserAndSandbox: true,
      requiresFrozenTool: true,
      requiresApprovedLiveService: true,
      hostPortPublished: false,
      publicUrl: false,
      inheritsSaasIdentity: false,
    }),
  );
}
