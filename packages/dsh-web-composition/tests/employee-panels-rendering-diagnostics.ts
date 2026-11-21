import type { CDPSession } from 'playwright-core';

// Exact refusal observed on the locked Chromium with the unchanged launch flags.
const commandLineUnavailable =
  'cdpSession.send: Protocol error (Browser.getBrowserCommandLine): Command line not returned because --enable-automation not set.';

/** Read-only test evidence. An unavailable optional command-line diagnostic must
 * not discard successful SystemInfo or change the browser's launch environment. */
export async function readPanelsRenderingDiagnostics(
  session: Pick<CDPSession, 'send' | 'detach'>,
) {
  try {
    const system = await session.send('SystemInfo.getInfo');
    try {
      const result = await session.send('Browser.getBrowserCommandLine');
      return { system, commandLine: { available: true as const, result } };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== 'Error' ||
        error.message !== commandLineUnavailable
      )
        throw error;
      return {
        system,
        commandLine: {
          available: false as const,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        },
      };
    }
  } finally {
    await session.detach();
  }
}
