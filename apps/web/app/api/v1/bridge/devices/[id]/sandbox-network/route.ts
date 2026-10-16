// Retired manual settings endpoint. Old open tabs must stop presenting the
// form; writes never create or widen a grant. Execution owns automatic checks.
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET() {
  return Response.json(
    { error: { message: '沙箱联网由后台自动检查。' } },
    { status: 404, headers },
  );
}
export async function PATCH() {
  return Response.json(
    {
      error: { message: '联网已改为自动检查，无需配置网站地址。请刷新页面。' },
    },
    { status: 410, headers },
  );
}
