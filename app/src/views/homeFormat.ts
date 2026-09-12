/**
 * Presentation helpers for Home. Kept free of JSX so they can be unit-tested
 * directly under Node's type stripping.
 */
import type { Settings } from '../state/hardware';

/**
 * Kernel profile names are not presentation text.
 *
 * Every label must be DISTINCT. This hardware (AN515-45, kernel 7.0) reports
 * five profiles — low-power, quiet, balanced, balanced-performance,
 * performance — so mapping both low-power and quiet to "Quiet", or both
 * balanced-performance and performance to "Performance", would render two
 * pairs of identically labelled tiles with no way to tell them apart.
 *
 * The ladder below keeps the NitroSense naming for the middle of the range
 * and gives the extremes their own names.
 */
const MODE_LABEL: Record<string, string> = {
  'low-power': 'Eco',
  quiet: 'Quiet',
  balanced: 'Balanced',
  'balanced-performance': 'Performance',
  performance: 'Turbo',
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

/**
 * The daemon returns an empty current profile when the driver cannot read it.
 * On this hardware `platform_profile` errors with EIO while `choices` reads
 * fine, so an empty current alongside a populated list means "unreadable",
 * not "none selected".
 */
export function profileUnreadable(
  current: string | undefined,
  available: string[] | undefined,
): boolean {
  return (available?.length ?? 0) > 0 && !current;
}
