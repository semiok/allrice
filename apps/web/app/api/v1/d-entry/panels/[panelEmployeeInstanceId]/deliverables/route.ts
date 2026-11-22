import { employeePanelsHandlers } from '../../../../../../../lib/d-entry/employee-panels-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = employeePanelsHandlers.listDeliverables;
export const POST = employeePanelsHandlers.uploadDeliverable;
