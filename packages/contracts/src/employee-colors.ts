import { z } from 'zod';

/** Approved bright Monet-inspired identity colors, shared by editor and tenant UI. */
export const employeeColorPalette = {
  blue: { label: '湖蓝', value: '#87C6EC' },
  teal: { label: '水绿', value: '#86D0BD' },
  green: { label: '柳绿', value: '#BAD58C' },
  amber: { label: '晨光黄', value: '#F4DA86' },
  orange: { label: '杏橙', value: '#F4B889' },
  coral: { label: '珊瑚', value: '#ED9D98' },
  rose: { label: '睡莲粉', value: '#ECAACB' },
  violet: { label: '鸢尾紫', value: '#B9A1DE' },
  indigo: { label: '暮蓝', value: '#8CA4D7' },
  gray: { label: '雾灰', value: '#B3C7D0' },
} as const;

// The approved pale fills need dark labels in both light and dark UI themes.
export const employeeColorForeground = '#1F2937';

export type EmployeeAccentColor = keyof typeof employeeColorPalette;
export const EmployeeAccentColorSchema = z.enum(
  Object.keys(employeeColorPalette) as EmployeeAccentColor[],
);

export function resolveEmployeeAccent(
  name: string,
  configured?: EmployeeAccentColor,
): EmployeeAccentColor {
  // Old published snapshots remain byte-for-byte unchanged. Once configured,
  // the saved color wins even when an employee is renamed.
  return configured ?? (/office/i.test(name) ? 'orange' : 'blue');
}
