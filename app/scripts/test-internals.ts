/**
 * Exercises InternalsManager against the stateful mock daemon.
 * Proves the before/after feature diff — the mechanism that makes a failed
 * driver reload visible instead of silent.
 */
import { HardwareClient } from '../electron/hardware-client.ts';
import { InternalsManager } from '../electron/internals.ts';

const SOCK = process.env.NITROSENSE_SOCKET ?? '/tmp/nitrosense-mock.sock';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  const client = new HardwareClient(SOCK);
  const internals = new InternalsManager(client);

  console.log('\n1. Unforced state (AN515-45-like: no parameter, thin features)');
  const initial = await internals.readState();
  check('laptop type unknown without a parameter', initial.laptopType === 'UNKNOWN', initial.laptopType);
  check('feature set is thin', initial.features.length === 1, `${initial.features.length} features`);
  check('no modprobe parameter', initial.modprobeParameter === '', initial.modprobeParameter);

  console.log('\n2. persist-nitro unlocks features');
  const persisted = await internals.persistParameter('nitro_v4');
  check('daemon came back after restart', persisted.daemonReturned === true);
  check('operation reported ok', persisted.ok === true, persisted.error ?? '');
  check('features gained', (persisted.diff?.gained.length ?? 0) === 8,
    `gained ${persisted.diff?.gained.length}`);
  check('nothing lost', (persisted.diff?.lost.length ?? 0) === 0);
  check('parameter now persistent', persisted.after?.modprobeParameter === 'nitro_v4',
    persisted.after?.modprobeParameter ?? 'null');
  check('laptop type now detected', persisted.after?.laptopType === 'NITRO');
  check('fan_speed among gained', persisted.diff?.gained.includes('fan_speed') === true);

  console.log('\n3. remove-param reverts (loss is reported, not hidden)');
  const removed = await internals.removeParameter();
  check('daemon came back', removed.daemonReturned === true);
  check('features lost are reported', (removed.diff?.lost.length ?? 0) === 8,
    `lost ${removed.diff?.lost.length}`);
  check('flagged not-ok because features were lost', removed.ok === false);
  check('warning names the loss', /Lost 8 feature/.test(removed.warning ?? ''), removed.warning ?? '');

  console.log('\n4. restart-daemon is a no-op for features');
  await internals.persistParameter('nitro_v4');
  const restarted = await internals.restartDaemon();
  check('daemon came back', restarted.daemonReturned === true);
  check('no feature change', (restarted.diff?.gained.length ?? 0) === 0 &&
    (restarted.diff?.lost.length ?? 0) === 0);
  check('warned that nothing changed', /No change/.test(restarted.warning ?? ''), restarted.warning ?? '');

  client.close();
  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
