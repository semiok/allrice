// Keep the browser's conventional fallback URL working alongside Next's icon metadata.
export function GET() {
  return new Response(null, {
    status: 308,
    headers: { Location: '/icon.svg' },
  });
}
