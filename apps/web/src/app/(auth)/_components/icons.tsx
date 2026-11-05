/**
 * Icons used by the auth pages — drawn from the Nuera icon set (24 px grid, stroke 1.8,
 * round caps, `currentColor`). Local until the UI kit's <Icon> is available.
 */
import type { SVGProps } from 'react';

const PATHS = {
  projets: [
    'M3 7C3 6.46957 3.21071 5.96086 3.58579 5.58579C3.96086 5.21071 4.46957 5 5 5H9L11 7H19C19.5304 7 20.0391 7.21071 20.4142 7.58579C20.7893 7.96086 21 8.46957 21 9V17C21 17.5304 20.7893 18.0391 20.4142 18.4142C20.0391 18.7893 19.5304 19 19 19H5C4.46957 19 3.96086 18.7893 3.58579 18.4142C3.21071 18.0391 3 17.5304 3 17V7Z',
  ],
  terminal: ['M4 17L10 11L4 5', 'M12 19H20'],
  check: ['M5 12L10 17L19 7'],
  key: [
    'M7.5 21C10.5376 21 13 18.5376 13 15.5C13 12.4624 10.5376 10 7.5 10C4.46243 10 2 12.4624 2 15.5C2 18.5376 4.46243 21 7.5 21Z',
    'M21 2L11.4 11.6',
    'M15.5 7.5L18.5 10.5L22 7L19 4',
  ],
  lock: [
    'M19 11H5C3.89543 11 3 11.8954 3 13V20C3 21.1046 3.89543 22 5 22H19C20.1046 22 21 21.1046 21 20V13C21 11.8954 20.1046 11 19 11Z',
    'M7 11V7C7 5.67392 7.52678 4.40215 8.46447 3.46447C9.40215 2.52678 10.6739 2 12 2C13.3261 2 14.5979 2.52678 15.5355 3.46447C16.4732 4.40215 17 5.67392 17 7V11',
  ],
  shield: ['M12 3L4 6V12C4 17 7.5 20 12 21C16.5 20 20 17 20 12V6L12 3Z', 'M9 12L11 14L15 10'],
  alert: ['M12 3L2 20H22L12 3Z', 'M12 10V14M12 17H12.01'],
  file: [
    'M15 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V7L15 2Z',
    'M14 2V6C14 6.53043 14.2107 7.03914 14.5858 7.41421C14.9609 7.78929 15.4696 8 16 8H20',
  ],
  'arrow-left': ['M12 19L5 12L12 5', 'M19 12H5'],
} as const;

export type AuthIconName = keyof typeof PATHS;

export function AuthIcon({
  name,
  size = 18,
  ...props
}: { name: AuthIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
