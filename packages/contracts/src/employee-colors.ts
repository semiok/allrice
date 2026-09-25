import { z } from 'zod';

/** Approved technology palette, shared by the editor and tenant UI. */
export const employeeColorPalette = {
  blue: { label: '科技蓝', value: '#3B82F6' },
  teal: { label: '湖水青', value: '#06B6D4' },
  green: { label: '薄荷绿', value: '#10B981' },
  lime: { label: '青柠', value: '#84CC16' },
  amber: { label: '明黄', value: '#EAB308' },
  orange: { label: '活力橙', value: '#F97316' },
  coral: { label: '珊瑚红', value: '#EF4444' },
  rose: { label: '玫瑰粉', value: '#EC4899' },
  violet: { label: '鸢尾紫', value: '#8B5CF6' },
  gray: { label: '石墨灰', value: '#64748B' },
} as const;

export type EmployeePaletteColor = keyof typeof employeeColorPalette;
// Keep old published snapshots valid; the retired indigo choice renders as blue.
export type EmployeeAccentColor = EmployeePaletteColor | 'indigo';

export const EmployeeAccentColorSchema = z.enum([
  ...Object.keys(employeeColorPalette),
  'indigo',
] as EmployeeAccentColor[]);

export function employeeColorForeground(color: EmployeePaletteColor) {
  return color === 'gray' ? '#FFFFFF' : '#090D16';
}

export function resolveEmployeeAccent(
  name: string,
  configured?: EmployeeAccentColor,
): EmployeePaletteColor {
  // Old published snapshots remain byte-for-byte unchanged. Once configured,
  // the saved color wins even when an employee is renamed.
  if (configured === 'indigo') return 'blue';
  return configured ?? (/office/i.test(name) ? 'orange' : 'blue');
}
