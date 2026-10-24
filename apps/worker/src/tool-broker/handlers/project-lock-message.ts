const cpuName = (a: string) =>
  a === 'amd64' ? 'Intel（x86_64）' : a === 'arm64' ? 'Apple 芯片（arm64）' : a;

/** Why nothing could run the project, and the one action that helps. A new
 * resolution always targets the server's CPU, so it only helps a Bridge of that CPU. */
export function projectLockPlatformMessage(error: {
  lockArchitectures: readonly string[];
  bridgeArchitectures: readonly string[];
  serverArchitecture: string;
  cloudBlocked: 'local_request' | 'local_inputs' | 'disabled' | null;
}) {
  const lock = error.lockArchitectures.length
    ? `只能装在 ${error.lockArchitectures.map(cpuName).join('、')} 上`
    : '在任何一种 CPU 架构上都装不全';
  const bridges = [...new Set(error.bridgeArchitectures)];
  const bridge = bridges.length
    ? `本机 Bridge 是 ${bridges.map(cpuName).join('、')}，装不上。`
    : '';
  const server = cpuName(error.serverArchitecture);
  const staleForThisBridge = bridges.includes(error.serverArchitecture);
  let next: string;
  if (error.cloudBlocked === null)
    next = `云端是 ${server}，也装不上。这通常是在另一种架构的服务器上解析的旧锁：请用 resolve 重新解析依赖（会按 ${server} 生成新的项目版本），再用新版本执行。`;
  else if (staleForThisBridge)
    next =
      error.cloudBlocked === 'local_inputs'
        ? `这是在另一种架构的服务器上解析的旧锁：请用 resolve 重新解析依赖（只上传依赖声明，不上传本机文件，会按 ${server} 生成本机可用的新项目版本），再用新版本在本机执行。`
        : error.cloudBlocked === 'local_request'
          ? '这是在另一种架构的服务器上解析的旧锁。重新解析要在云端进行，而本次任务要求只在本机处理，所以本次不能重新解析；请用户在允许云端解析依赖的任务里重新解析，或提供本机可用的锁文件。'
          : '这是在另一种架构的服务器上解析的旧锁。重新解析要在云端进行，但云端执行没有开启或这个员工不能使用；开启后用 resolve 重新解析，或提供本机可用的锁文件。';
  else
    next =
      `依赖解析目前只按服务器的 CPU 架构（${server}）生成锁，还不能为本机生成可用的锁。` +
      (error.cloudBlocked === 'local_request'
        ? '如果可以在云端执行，请用户去掉"只在本机运行"的要求后再试。'
        : error.cloudBlocked === 'local_inputs'
          ? '本次任务带有本机输入，只能在本机执行，所以暂时无法完成；可以改用不含原生扩展的纯 Python 依赖。'
          : '云端执行没有开启或这个员工不能使用；开启后可以在云端执行。');
  return `这个项目的依赖锁里有${lock}的安装包，本次没有执行。${bridge}${next}`;
}
