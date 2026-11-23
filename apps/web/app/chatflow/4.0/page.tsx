import { EmployeeNativePage } from './employee-native-page';

export const dynamic = 'force-dynamic';

export default async function EmployeeNativeEntryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    // Preserve duplicates/unknown keys for the authenticated document's strict
    // parser. The page neither resolves identity nor silently repairs input.
    for (const item of Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value])
      query.append(key, item);
  }
  return (
    <EmployeeNativePage source={`/chatflow/4.0/document?${query.toString()}`} />
  );
}
