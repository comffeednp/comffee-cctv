import type { JSX } from 'preact';
import { cx } from './cx.ts';

/*
 * A small inline SVG icon set on a 24 unit grid: 1.75 stroke, round caps, drawn in currentColor.
 * Each icon is a list of shapes: a string is a path, `c` a circle [cx, cy, r], `r` a rect
 * [x, y, w, h, rx]; `f` fills the shape instead of stroking it.
 */

type Shape = string | { c: [number, number, number]; f?: true } | { r: [number, number, number, number, number]; f?: true } | { d: string; f: true };

const ICONS = {
  live: [
    { c: [12, 12, 2.5], f: true },
    'M7.76 7.76a6 6 0 0 0 0 8.48',
    'M16.24 7.76a6 6 0 0 1 0 8.48',
    'M4.93 4.93a10 10 0 0 0 0 14.14',
    'M19.07 4.93a10 10 0 0 1 0 14.14',
  ],
  recordings: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'],
  cameras: [{ r: [3, 4, 18, 4, 1] }, 'M5 8a7 7 0 0 0 14 0', { c: [12, 11.5, 2] }],
  locations: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', { c: [12, 9.5, 2.5] }],
  settings: [
    'M9.54 5.23L10.19 2.67L13.81 2.67L14.46 5.23L15.04 5.47L17.31 4.12L19.88 6.69L18.53 8.96L18.77 9.54L21.33 10.19L21.33 13.81L18.77 14.46L18.53 15.04L19.88 17.31L17.31 19.88L15.04 18.53L14.46 18.77L13.81 21.33L10.19 21.33L9.54 18.77L8.96 18.53L6.69 19.88L4.12 17.31L5.47 15.04L5.23 14.46L2.67 13.81L2.67 10.19L5.23 9.54L5.47 8.96L4.12 6.69L6.69 4.12L8.96 5.47Z',
    { c: [12, 12, 3] },
  ],
  record: [{ c: [12, 12, 9] }, { c: [12, 12, 5], f: true }],
  pause: [{ r: [6, 5, 4, 14, 1], f: true }, { r: [14, 5, 4, 14, 1], f: true }],
  play: [{ d: 'M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.5-7.2a.8.8 0 0 0 0-1.4L8.2 4.1a.8.8 0 0 0-1.2.7z', f: true }],
  fullscreen: ['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5'],
  'exit-fullscreen': ['M9 4v5H4', 'M20 9h-5V4', 'M15 20v-5h5', 'M4 15h5v5'],
  detect: [
    'M4 8V6a2 2 0 0 1 2-2h2',
    'M16 4h2a2 2 0 0 1 2 2v2',
    'M20 16v2a2 2 0 0 1-2 2h-2',
    'M8 20H6a2 2 0 0 1-2-2v-2',
    { c: [12, 12, 3] },
  ],
  chevron: ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  copy: [{ r: [9, 9, 11, 11, 2] }, 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  calendar: [{ r: [3, 5, 18, 16, 2] }, 'M3 10h18', 'M8 3v4', 'M16 3v4'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', { c: [4.5, 6, 1], f: true }, { c: [4.5, 12, 1], f: true }, { c: [4.5, 18, 1], f: true }],
  timeline: [{ r: [3, 6, 7, 8, 1.5] }, { r: [13, 6, 8, 8, 1.5] }, 'M3 19h18'],
  grid: [{ r: [4, 4, 7, 7, 1.5] }, { r: [13, 4, 7, 7, 1.5] }, { r: [4, 13, 7, 7, 1.5] }, { r: [13, 13, 7, 7, 1.5] }],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  warning: ['M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z', 'M12 9.5v4', { c: [12, 17, 0.9], f: true }],
  info: [{ c: [12, 12, 9] }, 'M12 11v5', { c: [12, 8, 0.9], f: true }],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4z', 'M13.5 6.5l4 4'],
  user: [{ c: [12, 8, 4] }, 'M4 21a8 8 0 0 1 16 0'],
  users: [{ c: [9, 8, 3.5] }, 'M2.5 20a6.5 6.5 0 0 1 13 0', 'M16 4.5a3.5 3.5 0 0 1 0 7', 'M18 14.2a6.5 6.5 0 0 1 3.5 5.8'],
  key: [{ c: [8, 15, 4] }, 'M11 12l9-9', 'M17 6l3 3', 'M14.5 8.5l2 2'],
  storage: [{ r: [3, 4, 18, 7, 2] }, { r: [3, 13, 18, 7, 2] }, { c: [7, 7.5, 0.9], f: true }, { c: [7, 16.5, 0.9], f: true }],
  shield: ['M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z'],
  audit: [{ r: [5, 3, 14, 18, 2] }, 'M9 8h6', 'M9 12h6', 'M9 16h3'],
  'log-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  refresh: ['M20 11a8 8 0 0 0-14.9-3.9L4 9', 'M4 4v5h5', 'M4 13a8 8 0 0 0 14.9 3.9L20 15', 'M20 20v-5h-5'],
  eye: ['M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7S2.5 12 2.5 12z', { c: [12, 12, 3] }],
  'eye-off': [
    'M3 3l18 18',
    'M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.6',
    'M6.6 6.6C3.9 8.4 2.5 12 2.5 12S6 19 12 19a9.7 9.7 0 0 0 5.4-1.6',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
  ],
  router: [{ r: [3, 13, 18, 7, 2] }, { c: [7, 16.5, 0.9], f: true }, 'M12 13V9', 'M8.5 6.5a5 5 0 0 1 7 0', 'M6 4a8.5 8.5 0 0 1 12 0'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  cloud: ['M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.5 4.5 0 0 1-1 9.5z'],
  more: [{ c: [5, 12, 1.4], f: true }, { c: [12, 12, 1.4], f: true }, { c: [19, 12, 1.4], f: true }],
  search: [{ c: [11, 11, 7] }, 'M20 20l-4-4'],
} satisfies Record<string, readonly Shape[]>;

export type IconName = keyof typeof ICONS;

/** Every icon name, for docs and tests. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  name: IconName;
  /** 16 in dense text, 18-20 in rows and buttons (default 20), 24 in navigation. */
  size?: 16 | 18 | 20 | 24 | 32;
  /** Give a label only when the icon stands alone and means something; otherwise it is hidden from screen readers. */
  label?: string;
  class?: string;
}

function renderShape(shape: Shape, index: number): JSX.Element {
  if (typeof shape === 'string') return <path key={index} d={shape} />;
  const fill = 'f' in shape && shape.f ? { fill: 'currentColor', stroke: 'none' } : {};
  if ('c' in shape) return <circle key={index} cx={shape.c[0]} cy={shape.c[1]} r={shape.c[2]} {...fill} />;
  if ('r' in shape) {
    const [x, y, width, height, rx] = shape.r;
    return <rect key={index} x={x} y={y} width={width} height={height} rx={rx} {...fill} />;
  }
  return <path key={index} d={shape.d} {...fill} />;
}

export function Icon({ name, size = 20, label, class: className }: IconProps) {
  const shapes: readonly Shape[] = ICONS[name];
  return (
    <svg
      class={cx('icon', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
    >
      {shapes.map(renderShape)}
    </svg>
  );
}
