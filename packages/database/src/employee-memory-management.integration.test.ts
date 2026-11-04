import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EmployeeMemoryTextSchema, type RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createRunAuthorityFixture } from './run-authority.fixture.ts';
import { authenticateSession, createSession, ensureBootstrapPortalPrincipal } from './identity.ts';
import { ensureGeneralEmployeeInstance, createEmployeeInstance } from './employees/employee-instances.ts';
import { createTraceableMemory, correctWorkspaceMemory, deleteWorkspaceMemory, promoteWorkspaceMemory } from './workspace/service.ts';
import { listPersonalEmployeeMemories, listAdminEmployeeMemories, previewEmployeeMemoryCapacity } from './employee-memory-management.ts';

const suite=process.env.ALLRICE_RUN_DB_INTEGRATION==='1'?describe.sequential:describe.skip;
suite('employee memory management: real identities, pages and administrator projection',()=>{
  let fixture:Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>, admin:RequestContext;
  beforeAll(async()=>{
    fixture=await createRuntimeFixtureDatabase();vi.spyOn(client,'getDatabase').mockReturnValue(fixture.db);
    const p=await ensureBootstrapPortalPrincipal({organizationSlug:'allrice-platform',organizationName:'Platform',workspaceSlug:'default',workspaceName:'Default',email:'memory-admin@example.test',displayName:'Admin',role:'member'});
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS',p.user.email);
    admin=(await authenticateSession((await createSession(p.user.id)).token))!;
  },120000);
  afterAll(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await fixture?.close();},30000);
  async function setup(){
    const f=await createRunAuthorityFixture(fixture.db);
    await ensureGeneralEmployeeInstance(fixture.db,f.assignment);
    const context=(await authenticateSession((await createSession(f.user)).token,{organizationId:f.org,workspaceId:f.workspace}))!;
    const other=await createEmployeeInstance(context,{workspaceId:f.workspace,assignmentId:f.assignment,requestId:randomUUID(),profile:{name:'Other'}});
    const save=(content:string,lifecycleState:'candidate'|'durable'='durable',instanceId=f.assignment)=>createTraceableMemory(context,{workspaceId:f.workspace,instanceId,idempotencyKey:randomUUID(),sourceType:'user',content,lifecycleState,memoryClass:'user_preference'});
    const page=(query:unknown={})=>listPersonalEmployeeMemories(context,f.workspace,f.assignment,query);
    return {...f,context,other,save,page};
  }
  const expected=(m:{instanceId:string|null;revision:number;contentDigest:string})=>({instanceId:m.instanceId!,expectedRevision:m.revision,contentDigest:m.contentDigest,idempotencyKey:randomUUID()});
  it('lists the current owner instance; direct edit confirms exactly what was saved; old confirmation conflicts',async()=>{
    const s=await setup(), memory=await s.save('月报常用入口','candidate');
    await s.save('别的实例入口','durable',s.other.id);
    expect((await s.page({state:'pending'})).memories.map(m=>m.id)).toEqual([memory.id]);
    const edited=await correctWorkspaceMemory(s.context,s.workspace,memory.id,{...expected(memory),content:'月报入口更新',reason:'本人编辑'});
    expect((await s.page({state:'confirmed'})).memories[0]).toMatchObject({id:memory.id,content:'月报入口更新',state:'confirmed',revision:2});
    await expect(promoteWorkspaceMemory(s.context,s.workspace,memory.id,expected(memory))).rejects.toThrow('employee_memory_conflict');
    await deleteWorkspaceMemory(s.context,s.workspace,memory.id,expected(edited));
    expect((await s.page()).memories).toEqual([]);
    expect((await s.page({state:'archived'})).memories[0]).toMatchObject({id:memory.id,state:'archived'});
  });
  it('paginates beyond 100 without crossing instances and budgets only confirmed unexpired records',async()=>{
    const s=await setup(), seed=await s.save('资料入口');
    await fixture.db`insert into allrice_memories(organization_id,workspace_id,employee_id,owner_id,instance_id,content,visibility,source_type,trust_level,lifecycle_state,memory_class)
      select organization_id,workspace_id,employee_id,owner_id,instance_id,content||n,'private','user','user_confirmed','durable','user_preference' from allrice_memories cross join generate_series(1,104) n where id=${seed.id}`;
    const ids:string[]=[];let after:string|undefined;
    do {const page=await s.page({state:'confirmed',after});expect(page.total).toBe(105);ids.push(...page.memories.map(m=>m.id));after=page.nextCursor??undefined;} while(after);
    expect(ids).toHaveLength(105);expect(new Set(ids).size).toBe(105);
    const page=await s.page();expect(page.budget).toMatchObject({eligibleCount:105,omittedCount:85,maxItems:20});
    expect(page.budget!.usedBytes).toBeLessThanOrEqual(6000);
    const expired=await s.save('过期入口');
    await fixture.db`update allrice_memories set created_at=now()-interval '3 days',captured_at=now()-interval '3 days',expires_at=now()-interval '1 day' where id=${expired.id}`;
    expect((await s.page({state:'expired'})).memories.map(m=>m.id)).toEqual([expired.id]);
    expect((await s.page()).budget!.selectedIds).not.toContain(expired.id);
    await expect(s.page({after:'not-an-id'})).rejects.toThrow();
  });
  it('rejects other people, foreign organizations and revoked owner access',async()=>{
    const s=await setup(), other=await setup();await s.save('不可泄露');
    await expect(listPersonalEmployeeMemories(other.context,s.workspace,s.assignment)).rejects.toThrow();
    await expect(listPersonalEmployeeMemories({...s.context,actor:other.context.actor},s.workspace,s.assignment)).rejects.toThrow();
    await fixture.db`update allrice_memberships set active=false where organization_id=${s.org} and user_id=${s.user}`;
    await expect(s.page()).rejects.toThrow();
  });
  it('allows only real administrator reads, records target metadata, and exposes no chat source or profile',async()=>{
    const s=await setup(), m=await s.save('月报前核查三项数据','candidate');
    const result=await listAdminEmployeeMemories(admin,s.org,s.user,s.assignment,{state:'pending'});
    expect(result.memories.map(row=>row.id)).toEqual([m.id]);expect(result.budget).toBeNull();
    const row=result.memories[0]!;expect(row).not.toHaveProperty('sourceId');expect(row).not.toHaveProperty('sourceExcerpt');expect(row).not.toHaveProperty('sourceLabel');expect(row).not.toHaveProperty('sessionId');
    const [audit]=await fixture.db`select actor_id,metadata from allrice_audit_events where action='employee_memory.admin_read' and resource_id=${s.assignment}`;
    expect(audit!.actor_id).toBe(admin.actor.id);expect(audit!.metadata).toMatchObject({ownerId:s.user,instanceId:s.assignment,returnedCount:1,state:'pending',after:null,limit:50});
    expect(JSON.stringify(audit)).not.toContain(m.content);
    await expect(listAdminEmployeeMemories(s.context,s.org,s.user,s.assignment)).rejects.toThrow();
    await expect(listAdminEmployeeMemories(admin,s.org,randomUUID(),s.assignment)).rejects.toThrow();
    await expect(listAdminEmployeeMemories(admin,randomUUID(),s.user,s.assignment)).rejects.toThrow();
    await expect(listAdminEmployeeMemories({...admin,sessionId:randomUUID()},s.org,s.user,s.assignment)).rejects.toThrow();
    expect((await s.page({state:'pending'})).memories[0]!.revision).toBe(1);
  });
  it('counts UTF-8 and whole items, never truncates contents or treats bytes as tokens',()=>{
    expect(EmployeeMemoryTextSchema.safeParse('中'.repeat(333)).success).toBe(true);
    expect(EmployeeMemoryTextSchema.safeParse('中'.repeat(334)).success).toBe(false);
    const rows=Array.from({length:20},()=>({id:randomUUID(),revision:1,content:'中'.repeat(330)}));
    const before=structuredClone(rows), result=previewEmployeeMemoryCapacity(rows,20);
    expect(result.selectedIds.length).toBeLessThan(20);expect(result.usedBytes).toBeLessThanOrEqual(6000);expect(result.omittedCount).toBe(20-result.selectedIds.length);expect(rows).toEqual(before);
    expect(previewEmployeeMemoryCapacity([],0).usedBytes).toBe(0);
  });
});
