import { z } from 'zod';

/** Shared identity colors for the editor and tenant UI; no arbitrary CSS. */
export const employeeColorPalette = {
  blue: { label: '蓝色', start: '#304fb1', end: '#3569c6' },
  sky: { label: '青蓝', start: '#1f659f', end: '#2478b5' },
  cyan: { label: '湖青', start: '#166b7f', end: '#187c91' },
  teal: { label: '松绿', start: '#1a6e60', end: '#21806f' },
  green: { label: '叶绿', start: '#356d41', end: '#42804e' },
  amber: { label: '琥珀', start: '#856316', end: '#99751d' },
  orange: { label: '橙色', start: '#a7491c', end: '#b75a23' },
  rose: { label: '玫粉', start: '#9e4265', end: '#b64f73' },
  violet: { label: '紫色', start: '#6d4ba6', end: '#805abf' },
  indigo: { label: '靛蓝', start: '#4c50a5', end: '#5d62bd' },
} as const;

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
