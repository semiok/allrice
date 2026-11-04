import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { RiceToolHandlerContext } from '../types.js';
const ports = vi.hoisted(() => ({authorize:vi.fn(),board:vi.fn(),brands:vi.fn()}));
vi.mock('@allrice/database', () => ({authorizeBrandContentTool:ports.authorize,getBrandContentBoard:ports.board,listBrandContentBrands:ports.brands}));
import { readBrandContent } from './brand-content.js';
describe('retained read-only brand tool', () => {
  it('reads the authenticated instance and forwards the live authority fence', async () => {
    const brandId=randomUUID(), instanceId=randomUUID(), workspaceId=randomUUID(), beforeCommit=vi.fn();
    const context={workspaceId};
    ports.authorize.mockResolvedValue({context,instanceId,beforeCommit});
    ports.board.mockResolvedValue({brand:{id:brandId}});
    const result=await readBrandContent({arguments:{brandId}, input:{sessionId:randomUUID(),userMessageId:randomUUID(),managedBrowserJobAttempt:1,managedBrowserJobLeaseToken:randomUUID(),call:{id:randomUUID()}}} as RiceToolHandlerContext);
    expect(ports.authorize).toHaveBeenCalledWith(expect.anything(),'workspace.brand_content.read');
    expect(ports.board).toHaveBeenCalledWith(context,{workspaceId,instanceId,brandId},{authority:'workflow',beforeCommit});
    expect(JSON.parse(result.modelContent)).toEqual({brand:{id:brandId}});
  });
});
