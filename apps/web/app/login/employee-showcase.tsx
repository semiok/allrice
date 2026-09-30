'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

const employees = [
  {
    name: 'Rice',
    initial: 'R',
    description: '研究、分析与日常工作',
    color: '#3b82f6',
    scale: 1,
    opacity: 1,
  },
  {
    name: 'Office 文档助手',
    initial: 'O',
    description: '文档、表格与演示文稿',
    color: '#f97316',
    scale: 0.96,
    opacity: 1,
  },
  {
    name: '数据分析师',
    initial: 'D',
    description: '数据整理、图表与业务洞察',
    color: '#06b6d4',
    scale: 0.92,
    opacity: 0.68,
  },
  {
    name: '行业研究员',
    initial: 'I',
    description: '行业研究、竞品分析与趋势追踪',
    color: '#8b5cf6',
    scale: 0.88,
    opacity: 0.42,
  },
  {
    name: '销售教练',
    initial: 'S',
    description: '商机梳理、沟通演练与销售复盘',
    color: '#10b981',
    scale: 0.84,
    opacity: 0.2,
  },
] as const;

/** Public role examples, independent of a tenant's actual employee assignments. */
export function EmployeeShowcase() {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const cards = list.current?.querySelectorAll<HTMLElement>('.auth-employee');
    if (!cards) return;
    // Transforms scale the entire card; reserve its actual visual height so
    // wrapped descriptions and font loading cannot overlap the next employee.
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        const height = entry.borderBoxSize[0]?.blockSize ?? card.offsetHeight;
        card.parentElement?.style.setProperty(
          '--employee-height',
          `${height}px`,
        );
      }
    });
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, []);

  return (
    <ul ref={list} className="auth-employee-list" aria-label="AI 员工岗位示例">
      {employees.map((employee) => (
        <li
          className="auth-employee-slot"
          key={employee.name}
          style={
            {
              '--employee-scale': employee.scale,
              '--employee-opacity': employee.opacity,
              '--employee-color': employee.color,
            } as CSSProperties
          }
        >
          <div className="auth-employee">
            <span
              className={`auth-employee-avatar${employee.initial === 'O' ? ' auth-employee-office' : ''}`}
              aria-hidden="true"
            >
              {employee.initial}
            </span>
            <div>
              <strong>{employee.name}</strong>
              <span>{employee.description}</span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
