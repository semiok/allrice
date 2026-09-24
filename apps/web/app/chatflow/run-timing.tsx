export function formatRunDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (ms > 0 && seconds === 0) return '不到 1 秒';
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
