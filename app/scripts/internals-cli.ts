/**
 * Internals Manager CLI — step 2 deliverable.
 *
 * Lets you apply/persist a modprobe parameter before any UI exists. The
 * Internals screen (after the Electron shell lands) binds to the same
 * InternalsManager module, so behaviour cannot drift between the two.
 *
 * Read-only:
 *     node scripts/internals-cli.ts status
 *
 * Mutating (each rmmods the driver and restarts the daemon; --yes required):
 *     node scripts/internals-cli.ts force-nitro       --yes
 *     node scripts/internals-cli.ts persist-nitro     --yes
 *     node scripts/internals-cli.ts remove-param      --yes
 *     node scripts/internals-cli.ts restart-daemon    --yes
 *     node scripts/internals-cli.ts restart-drivers   --yes
 */
import { HardwareClient, HardwareError } from '../electron/hardware-client.ts';
import { InternalsManager } from '../electron/internals.ts';
import type { OperationResult, ModprobeParam } from '../electron/internals.ts';

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

type Action = {
  summary: string;
  persistence: string;
  run: (m: InternalsManager) => Promise<OperationResult>;
};

const ACTIONS: Record<string, Action> = {
  'force-nitro': {
    summary: 'Reload the driver with nitro_v4',
    persistence: yellow('temporary — lost on reboot'),
    run: (m) => m.forceModel('nitro_v4' as ModprobeParam),
  },
  'force-predator': {
    summary: 'Reload the driver with predator_v4',
    persistence: yellow('temporary — lost on reboot'),
    run: (m) => m.forceModel('predator_v4' as ModprobeParam),
  },
  'force-enable-all': {
    summary: 'Reload the driver with enable_all',
    persistence: yellow('temporary — lost on reboot'),
    run: (m) => m.forceModel('enable_all' as ModprobeParam),
  },
  'persist-nitro': {
    summary: 'Write nitro_v4 to /etc/modprobe.d/linuwu-sense.conf, then reload',
    persistence: green('persistent — survives reboot'),
    run: (m) => m.persistParameter('nitro_v4' as ModprobeParam),
  },
  'persist-predator': {
    summary: 'Write predator_v4 to /etc/modprobe.d/linuwu-sense.conf, then reload',
    persistence: green('persistent — survives reboot'),
    run: (m) => m.persistParameter('predator_v4' as ModprobeParam),
  },
  'persist-enable-all': {
    summary: 'Write enable_all to /etc/modprobe.d/linuwu-sense.conf, then reload',
    persistence: green('persistent — survives reboot'),
    run: (m) => m.persistParameter('enable_all' as ModprobeParam),
  },
  'remove-param': {
    summary: 'Remove the persistent parameter, fall back to autodetection',
    persistence: green('persistent — survives reboot'),
    run: (m) => m.removeParameter(),
  },
  'restart-daemon': {
    summary: 'Restart the daemon service only (driver untouched)',
    persistence: dim('recovery — safest option'),
    run: (m) => m.restartDaemon(),
  },
  'restart-drivers': {
    summary: 'rmmod + modprobe the driver, then restart the daemon',
    persistence: red('recovery — can drop features if the reload fails'),
    run: (m) => m.restartDriversAndDaemon(),
  },
};

function printState(label: string, s: { laptopType: string; driverVersion: string; modprobeParameter: string; features: string[] }): void {
  console.log(`  ${bold(label)}`);
  console.log(`    Laptop type        ${s.laptopType}`);
  console.log(`    Driver version     ${s.driverVersion || dim('—')}`);
  console.log(`    Modprobe parameter ${s.modprobeParameter || dim('(none)')}`);
  console.log(`    Features (${s.features.length})       ${s.features.join(', ') || dim('none')}`);
}

function usage(): void {
  console.log(`\n${bold('Internals Manager')} ${dim('— driver/model management')}\n`);
  console.log(`  ${bold('status')}  ${dim('(read-only, safe)')}\n`);
  for (const [name, a] of Object.entries(ACTIONS)) {
    console.log(`  ${bold(name.padEnd(20))} ${a.summary}`);
    console.log(`  ${' '.repeat(20)} ${a.persistence}`);
  }
  console.log(`\n  ${dim('Mutating actions rmmod the driver and restart the daemon; pass --yes.')}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith('--'));
  const confirmed = argv.includes('--yes');

  if (!cmd || cmd === 'help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const client = new HardwareClient();
  const internals = new InternalsManager(client);

  try {
    await client.connect();
  } catch (e) {
    const err = e as HardwareError;
    console.log(`\n${red('Could not connect.')} ${err.message}\n`);
    console.log(dim('  systemctl status nitrosense-daemon.service'));
    console.log(dim('  lsmod | grep linuwu_sense\n'));
    process.exit(1);
  }

  if (cmd === 'status') {
    const s = await internals.readState();
    console.log();
    printState('Current', s);
    if (!s.modprobeParameter && s.features.length < 10) {
      console.log(`\n  ${yellow('Suggestion')}  features look incomplete and no parameter is set.`);
      console.log(`              ${dim('Try:  node scripts/internals-cli.ts persist-nitro --yes')}`);
    }
    console.log();
    client.close();
    return;
  }

  const action = ACTIONS[cmd];
  if (!action) {
    console.log(`\n${red(`Unknown action: ${cmd}`)}`);
    usage();
    client.close();
    process.exit(1);
  }

  if (!confirmed) {
    console.log(`\n  ${bold(cmd)} — ${action.summary}`);
    console.log(`  ${action.persistence}`);
    console.log(`\n  ${yellow('This unloads and reloads the kernel driver and restarts the daemon.')}`);
    console.log(`  ${dim('Re-run with --yes to proceed.')}\n`);
    client.close();
    process.exit(1);
  }

  console.log(`\n  ${bold(cmd)} — ${action.summary}`);
  console.log(`  ${dim('Working… the daemon sleeps 2s + 3s before restarting.')}\n`);

  const result = await action.run(internals);

  printState('Before', result.before);
  if (result.after) {
    console.log();
    printState('After', result.after);
  }

  if (result.diff) {
    console.log();
    if (result.diff.gained.length) {
      console.log(`  ${green('Gained')}  ${result.diff.gained.join(', ')}`);
    }
    if (result.diff.lost.length) {
      console.log(`  ${red('Lost')}    ${result.diff.lost.join(', ')}`);
    }
    if (!result.diff.gained.length && !result.diff.lost.length) {
      console.log(`  ${dim('No feature changes.')}`);
    }
  }

  if (result.warning) console.log(`\n  ${yellow('Warning')}  ${result.warning}`);
  if (result.error) console.log(`\n  ${red('Error')}    ${result.error}`);

  console.log(`\n  ${result.ok ? green('Completed.') : red('Completed with problems.')}\n`);
  client.close();
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => { console.error('internals-cli failed:', e); process.exit(1); });
