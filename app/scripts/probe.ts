/**
 * Connects to the real hardware service and reports exactly what
 * this machine supports. Replaces the manual `nc -U` check.
 *
 * Run from a NORMAL terminal (not a Flatpak/snap shell, which cannot see the
 * host's /run):
 *     node scripts/probe.ts
 */
import { HardwareClient, HardwareError, DEFAULT_SOCKET_PATH } from '../electron/hardware-client.ts';

/** Every feature the daemon can gate, with the UI area that depends on it. */
const FEATURE_MAP: Array<[string, string]> = [
  ['thermal_profile', 'Mode tiles (Quiet/Balanced/Performance/Turbo)'],
  ['fan_speed', 'Fan control + RPM readout'],
  ['battery_limiter', 'Battery limiter toggle'],
  ['battery_calibration', 'Battery calibration'],
  ['backlight_timeout', 'Keyboard backlight timeout'],
  ['boot_animation_sound', 'Boot animation + sound'],
  ['lcd_override', 'LCD override'],
  ['usb_charging', 'USB charging level (0/10/20/30)'],
  ['per_zone_mode', 'Per-zone keyboard RGB'],
  ['four_zone_mode', 'Four-zone keyboard RGB'],
];

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

async function main(): Promise<void> {
  const client = new HardwareClient();
  console.log(`\n${bold('hardware service probe')}  ${dim(client.socketPath)}\n`);

  try {
    await client.connect();
    console.log(green('  Connected.') + '\n');
  } catch (e) {
    const err = e as HardwareError;
    console.log(red('  Could not connect.'));
    console.log(`  ${err.message}\n`);
    console.log(dim('  Checks:'));
    console.log(dim('    systemctl status nitrosense-daemon.service'));
    console.log(dim('    lsmod | grep linuwu_sense'));
    console.log(dim(`    ls -la ${DEFAULT_SOCKET_PATH}\n`));
    process.exit(1);
  }

  const res = await client.send('get_all_settings');
  if (!res.success) {
    console.log(red(`  get_all_settings failed: ${res.error ?? 'unknown error'}\n`));
    client.close();
    process.exit(1);
  }

  const d = res.data as Record<string, any>;
  const features: string[] = Array.isArray(d.available_features) ? d.available_features : [];

  console.log(bold('  Device'));
  console.log(`    Laptop type        ${d.laptop_type ?? dim('—')}`);
  console.log(`    Daemon version     ${d.version ?? dim('—')}`);
  console.log(`    Driver version     ${d.driver_version ?? dim('—')}`);
  console.log(`    Modprobe parameter ${d.modprobe_parameter || dim('(none)')}`);
  console.log(`    Four-zone keyboard ${d.has_four_zone_kb ? 'yes' : 'no'}\n`);

  const tp = d.thermal_profile as { current?: string; available?: string[] } | undefined;
  if (tp?.available?.length) {
    console.log(bold('  Thermal profiles') + dim('  (these drive the mode tiles)'));
    console.log(`    Available  ${tp.available.join(', ')}`);
    console.log(`    Current    ${tp.current || dim('—')}\n`);
  }

  console.log(bold(`  Features  ${features.length}/${FEATURE_MAP.length} available`));
  for (const [key, label] of FEATURE_MAP) {
    const on = features.includes(key);
    console.log(`    ${on ? green('  ok  ') : red(' n/a ')} ${key.padEnd(22)} ${dim(label)}`);
  }

  // AN515-45 is absent from Compatibility.md; its siblings (AN515-44/47,
  // AN517-54) all require the nitro_v4 force via the Internals Manager.
  if (features.length < FEATURE_MAP.length && !d.modprobe_parameter) {
    console.log(`\n${yellow('  Suggestion')}`);
    console.log('    Features are missing and no modprobe parameter is set.');
    console.log('    On AN515-series hardware this is usually fixed by forcing nitro_v4');
    console.log('    (Internals Manager, step 2). Temporary: force_nitro_model.');
    console.log('    Persistent: set_modprobe_parameter_nitro.');
  }

  console.log(`\n${dim('  Raw get_all_settings:')}`);
  console.log(dim(JSON.stringify(d, null, 2).split('\n').map((l) => '    ' + l).join('\n')));

  console.log();
  client.close();
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
