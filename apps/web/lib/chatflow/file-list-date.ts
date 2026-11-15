/** Compact directory dates follow the viewer's local calendar, as the UI does. */
export function formatFileListDate(value: string, now = new Date()): string {
  const date = new Date(value);
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return today
    ? `今日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : `${date.getMonth() + 1}/${date.getDate()}`;
}
