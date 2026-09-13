/** A thermal-profile tile. Icon is chosen from the kernel profile name. */
import type { JSX } from 'react';

type Props = {
  name: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

/** Needle angle for a mode, degrees anticlockwise from east. */
function needleAngle(name: string): number {
  const n = name.toLowerCase();
  if (n.includes('turbo')) return 5;
  if (n.includes('performance') && !n.includes('balanced')) return 32;
  if (n.includes('low-power') || n.includes('quiet')) return 148;
  return 90; // balanced, and the fallback
}

/**
 * One instrument, four needle positions.
 *
 * The modes previously had unrelated pictograms — a crescent, chevrons, a
 * flame, a pair of scales — which read as clip art because nothing tied them
 * together. A single dial with the needle swept further round says "more
 * power" without having to be decoded, and the tiles read as a set.
 */
function Icon({ name }: { name: string }): JSX.Element {
  const cx = 16;
  const cy = 18.5;
  const rad = (needleAngle(name) * Math.PI) / 180;

  // A short tail through the hub, so the needle reads as balanced on a spindle
  // rather than as an arrow stuck to the middle.
  const tipX = cx + Math.cos(rad) * 9.2;
  const tipY = cy - Math.sin(rad) * 9.2;
  const tailX = cx - Math.cos(rad) * 2.6;
  const tailY = cy + Math.sin(rad) * 2.6;

  // Longer ticks at each end of the sweep, shorter in between.
  const ticks = [200, 165, 130, 90, 50, 15, -20].map((deg, i) => {
    const r = (deg * Math.PI) / 180;
    const major = i === 0 || i === 6;
    const inner = major ? 8.6 : 9.6;
    return (
      <line
        key={deg}
        x1={cx + Math.cos(r) * inner}
        y1={cy - Math.sin(r) * inner}
        x2={cx + Math.cos(r) * 11.6}
        y2={cy - Math.sin(r) * 11.6}
        strokeWidth={major ? 1.6 : 1}
        opacity={major ? 0.9 : 0.45}
      />
    );
  });

  return (
    <g>
      {/* Dial arc, sweeping 200 degrees round to -20. */}
      <path d="M4.6 22.4 A 12 12 0 1 1 27.4 22.4" strokeWidth="1.5" opacity="0.55" />
      {ticks}
      <line x1={tailX} y1={tailY} x2={tipX} y2={tipY} strokeWidth="2.2" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="2.2" fill="currentColor" stroke="none" />
    </g>
  );
}

export function ModeTile({ name, label, selected, disabled, onSelect }: Props): JSX.Element {
  return (
    <button
      type="button"
      className={`mode-tile${selected ? ' is-selected' : ''}`}
      disabled={disabled}
      onClick={onSelect}
      aria-pressed={selected}
      title={name}
    >
      {/* fill stays none: the dial is a stroked instrument, and filling it on
          selection would close the arc into a blob. Selection is carried by
          the tile's own colour, which currentColor picks up. */}
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"
           fill="none" stroke="currentColor" strokeWidth="1.6"
           strokeLinejoin="round" strokeLinecap="round">
        <Icon name={name} />
      </svg>
      <span className="mode-tile-label">{label}</span>
      <span className="mode-tile-raw">{name}</span>
    </button>
  );
}
