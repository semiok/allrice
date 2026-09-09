import { experienceHttp } from '../../../../../lib/experience/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => experienceHttp(request, 'sources');
