import type { SVGProps } from 'react';

import { allriceBrandColors, allriceRiceGrains } from '../lib/brand/rice-star';

export function AllriceMark({
  size = 24,
  ...props
}: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="currentColor"
      {...props}
    >
      {allriceRiceGrains.map((d, index) => (
        <path
          key={d}
          d={d}
          fill={index === 7 ? allriceBrandColors.gold : undefined}
        />
      ))}
    </svg>
  );
}
