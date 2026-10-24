import type { ProjectLockPlatformFacts } from '@allrice/database';

const cpu = (a: string) =>
  a === 'amd64' ? 'Intel（x86_64）' : a === 'arm64' ? 'Apple 芯片（arm64）' : a;

/** States why nothing could run the project and lists only options that can work:
 * a resolve runs in the cloud (refused when the user keeps the task local) and pins
 * wheels for the `architecture` it is given (default: the server's CPU). */
export function projectLockPlatformMessage(f: ProjectLockPlatformFacts) {
  const bridges = [...new Set(f.bridgeArchitectures)];
  const lockFitsServer = f.lockArchitectures.includes(f.serverArchitecture);
  const cloudMayRun =
    f.cloudUsable !== false && !f.userLocalOnly && !f.localInputs;
  const canResolve = f.cloudUsable !== false && !f.userLocalOnly;
  const parts = [
    `这个项目的依赖锁里有${
      f.lockArchitectures.length
        ? `只能装在 ${f.lockArchitectures.map(cpu).join('、')} 上`
        : '在任何一种 CPU 架构上都装不全'
    }的安装包，本次没有执行。`,
  ];
  if (bridges.length)
    parts.push(`本机 Bridge 是 ${bridges.map(cpu).join('、')}，装不上。`);
  if (cloudMayRun && !f.toolLocal && !lockFitsServer)
    parts.push(`云端是 ${cpu(f.serverArchitecture)}，也装不上。`);
  const blocked = [
    ...(f.userLocalOnly ? ['用户要求只在本机处理'] : []),
    ...(f.localInputs ? ['任务带有本机文件，只能在本机执行'] : []),
    ...(f.cloudUsable === false
      ? ['云端执行没有开启，或这个员工不能使用']
      : []),
  ];
  if (blocked.length) parts.push(`另外：${blocked.join('；')}。`);
  const options: string[] = [];
  if (canResolve)
    for (const architecture of bridges)
      options.push(
        `用 resolve 重新解析依赖并指定 architecture: ${architecture}（只上传依赖声明，生成 ${cpu(architecture)} 可用的新项目版本），再用新版本在本机执行`,
      );
  if (cloudMayRun && lockFitsServer && f.toolLocal)
    options.push('不限定在本机执行（去掉 location: local），让它在云端执行');
  if (cloudMayRun && !lockFitsServer && canResolve)
    options.push(
      `用 resolve 按默认架构（${cpu(f.serverArchitecture)}）重新解析，再在云端执行`,
    );
  if (!canResolve)
    parts.push(
      f.userLocalOnly
        ? '重新解析依赖要在云端进行，本次任务不允许；需要的话，请用户在允许云端处理的任务里重新解析，或提供本机可用的锁文件。'
        : '重新解析依赖要在云端进行，但云端执行不可用；需要的话，请开启云端执行，或提供本机可用的锁文件。',
    );
  return (
    parts.join('') +
    (options.length
      ? `可以：${options.map((o, i) => `${i + 1}. ${o}`).join('；')}。`
      : '')
  );
}
