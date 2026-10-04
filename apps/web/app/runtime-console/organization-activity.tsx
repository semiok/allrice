'use client';
import { useEffect, useState } from 'react';
import type { OrganizationActivityOverview } from '@allrice/contracts';
import { AdminButton as Button } from '../../components/admin/admin-ui';
import { useActivityPages } from './organization-activity-data';
import { CompanyDashboard } from './company-dashboard';
import styles from './admin-data.module.css';

export function OrganizationActivity() {
  const [organizationId, setOrganizationId] = useState('');
  const [userId, setUserId] = useState('');
  const overview = useActivityPages<OrganizationActivityOverview>(
    '/api/v1/admin/activity?view=companies',
    'organizations',
  );
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setOrganizationId(p.get('organizationId') ?? '');
    setUserId(p.get('subjectId') ?? '');
  }, []);
  function choose(org: string, user = '') {
    setOrganizationId(org);
    setUserId(user);
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'activity');
    for (const [key, value] of [
      ['organizationId', org],
      ['subjectId', user],
    ]) {
      if (value) url.searchParams.set(key!, value);
      else url.searchParams.delete(key!);
    }
    window.history.replaceState(null, '', url);
  }
  return (
    <section className={styles.page} aria-label="公司看板">
      <header className={styles.pageHeader}>
        <h1>公司看板</h1>
        <p>查看公司的实际工作、交付成果和已记录用量。</p>
      </header>
      <div className={styles.selectors}>
        <label>
          公司
          <select
            aria-label="公司"
            value={organizationId}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">选择公司</option>
            {organizationId &&
              !overview.data?.organizations.some(
                (o) => o.id === organizationId,
              ) && <option value={organizationId}>所选公司</option>}
            {overview.data?.organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          icon="refresh"
          variant="quiet"
          disabled={overview.loading}
          onClick={() => void overview.load()}
        >
          刷新公司列表
        </Button>
        {overview.data?.nextCursor && (
          <Button
            disabled={overview.loading}
            onClick={() => void overview.load(true)}
          >
            更多公司
          </Button>
        )}
      </div>
      {overview.error && <p role="alert">{overview.error}</p>}
      {!overview.data && overview.loading && <p role="status">正在读取公司…</p>}
      {organizationId ? (
        <CompanyDashboard
          key={organizationId}
          organizationId={organizationId}
          selectedUserId={userId}
          onUser={(id) => choose(organizationId, id)}
        />
      ) : (
        <p>
          选择公司后，可查看全公司的工作，也可以按员工、岗位或 AI 员工筛选。
        </p>
      )}
    </section>
  );
}
