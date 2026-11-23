/** The product entry owns one same-origin native document. No Host identity,
 * Context or permissions cross this document boundary. */
export function EmployeeNativePage({ source }: { source: string }) {
  return (
    <iframe
      title="员工工作区"
      src={source}
      referrerPolicy="no-referrer"
      style={{ display: 'block', width: '100%', height: '100dvh', border: 0 }}
    />
  );
}
