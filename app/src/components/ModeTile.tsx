/** A thermal-profile tile. Icon is chosen from the kernel profile name. */
import type { JSX } from 'react';

type Props = {
  name: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

function Icon({ name }: { name: string }): JSX.Element {
  const n = name.toLowerCase();
  if (n.includes('low-power') || n.includes('quiet')) {
    // Crescent: quiet
    return <path d="M20 6a10 10 0 1 0 6 18A12 12 0 0 1 20 6Z" />;
  }
  if (n.includes('performance') && !n.includes('balanced')) {
    // Chevrons: performance
    return <path d="M8 22 L16 8 L16 17 L24 4 L24 20 L16 20 L16 26 Z" />;
  }
  if (n.includes('turbo')) {
    // Flame: turbo
    return <path d="M16 2c4 6 8 8 8 14a8 8 0 0 1-16 0c0-3 2-5 3-8 1 3 3 4 3 6 1-4-1-8 2-12Z" />;
  }
  // Balance: balanced / fallback
  return <path d="M16 4v22M8 12h16M9 12l-4 8h8ZM23 12l-4 8h8Z" />;
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
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true"
           fill={selected ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6"
           strokeLinejoin="round">
        <Icon name={name} />
      </svg>
      <span className="mode-tile-label">{label}</span>
      <span className="mode-tile-raw">{name}</span>
    </button>
  );
}
