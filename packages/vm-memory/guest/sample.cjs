// Diagnostic-only guest sample. Root may edit it; no admission authority.
const fs = require('node:fs');
const path = require('node:path');
function sample(config, io = fs) {
  const read = (file) => {
    try {
      return io.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };
  const number = (text) =>
    text !== null && /^\d+\s*$/.test(text) && Number.isSafeInteger(Number(text))
      ? Number(text)
      : null;
  const keyed = (text, key, factor = 1) => {
    const line = text
      ?.split('\n')
      .find((line) => line.split(/[\s:]+/)[0] === key);
    if (!line) return null;
    const n = number(line.split(/[\s:]+/)[1]);
    return n !== null && Number.isSafeInteger(n * factor) ? n * factor : null;
  };
  const meminfo = read(path.join(config.procRoot, 'meminfo'));
  const group = (root, key) => number(read(path.join(root, key)));
  return {
    ramBytes: keyed(meminfo, 'MemTotal', 1024),
    availableBytes: keyed(meminfo, 'MemAvailable', 1024),
    swapTotalBytes: keyed(meminfo, 'SwapTotal', 1024),
    swapFreeBytes: keyed(meminfo, 'SwapFree', 1024),
    commandRamBytes: group(config.commandsGroup, 'memory.current'),
    commandSwapBytes: group(config.commandsGroup, 'memory.swap.current'),
    dshRamBytes: group(config.dshGroup, 'memory.current'),
    dshSwapBytes: group(config.dshGroup, 'memory.swap.current'),
    commandOomKills: keyed(
      read(path.join(config.commandsGroup, 'memory.events')),
      'oom_kill',
    ),
    parentLocalOoms: keyed(
      read(path.join(config.commandsGroup, 'memory.events.local')),
      'oom',
    ),
    globalOomKills: keyed(
      read(path.join(config.procRoot, 'vmstat')),
      'oom_kill',
    ),
  };
}
module.exports = { sample };
if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(sample(config)) + '\n');
}
