/** What the AllRice 助手 package is called and built for (MET-214). */

// Unchanged on disk so existing installs, pairings and updates carry over;
// Finder shows "AllRice 助手" through InfoPlist.strings in these languages.
export const bridgeAppBundle = 'Rice Bridge.app';
export const bridgeAppLocalizations = ['zh-Hans', 'en'];
export const bridgeAppArchive = 'AllRice-Assistant.zip';

/** Only the Apple silicon build is published. The SEA, PDF, FileGuardian and
 * terminal builds each read ALLRICE_BRIDGE_APP_ARCH and otherwise fall back to
 * the host architecture, so the default goes into the environment they
 * inherit: an Intel host then still builds every part for Apple silicon. */
export function pinBridgeAppArch(environment) {
  environment.ALLRICE_BRIDGE_APP_ARCH ??= 'arm64';
  if (environment.ALLRICE_BRIDGE_APP_ARCH !== 'arm64')
    throw Error('Only the Apple silicon build of AllRice 助手 is published');
  return environment.ALLRICE_BRIDGE_APP_ARCH;
}
