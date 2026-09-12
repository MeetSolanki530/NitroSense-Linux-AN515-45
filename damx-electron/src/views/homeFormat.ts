/**
 * Presentation helpers for Home. Kept free of JSX so they can be unit-tested
 * directly under Node's type stripping.
 */
import type { Settings } from '../state/damx';

/** Kernel profile names are not presentation text. */
const MODE_LABEL: Record<string, string> = {
  'low-power': 'Quiet',
  quiet: 'Quiet',
  balanced: 'Balanced',
  'balanced-performance': 'Performance',
  performance: 'Performance',
  turbo: 'Turbo',
};

export function prettyMode(raw: string | undefined): string {
  if (!raw) return 'Unknown';
  const mapped = MODE_LABEL[raw];
  if (mapped) return mapped;
  const spaced = raw.replace(/[-_]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The daemon reports fan speed as a percentage; 0/0 means automatic. */
export function fanLabel(settings: Settings | null): string {
  const fan = settings?.fan_speed;
  if (!fan) return '--';
  const cpu = Number(fan.cpu ?? NaN);
  const gpu = Number(fan.gpu ?? NaN);
  if (!Number.isFinite(cpu) || !Number.isFinite(gpu)) return '--';
  if (cpu === 0 && gpu === 0) return 'Auto';
  return `${cpu}% / ${gpu}%`;
}
