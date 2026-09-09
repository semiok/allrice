import { handleLocalBrowserRequest } from '../../../../../lib/bridge/local-browser-runtime';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = (request: Request) => handleLocalBrowserRequest(request);
