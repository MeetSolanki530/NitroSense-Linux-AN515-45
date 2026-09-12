/**
 * Exercises HardwareClient against the mock daemon. Covers the three things that
 * are hard about this protocol: split replies, one-in-flight serialisation,
 * and disruptive commands that never reply.
 */
import { HardwareClient, HardwareError } from '../electron/hardware-client.ts';

const SOCK = process.env.NITROSENSE_SOCKET ?? '/tmp/nitrosense-mock.sock';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n1. Split reply reassembly');
  {
    const c = new HardwareClient(SOCK);
    const res = await c.send('get_all_settings');
    const data = res.data as Record<string, unknown>;
    const feats = data?.available_features as string[];
    check('reassembles a reply split across 3 writes', res.success === true);
    check('parsed payload is intact', Array.isArray(feats) && feats.length === 9,
      `got ${Array.isArray(feats) ? feats.length : typeof feats}`);
    check('top-level laptop_type present', data?.laptop_type === 'NITRO');
    c.close();
  }

  console.log('\n2. Concurrent sends are serialised (one in flight)');
  {
    const c = new HardwareClient(SOCK);
    const results = await Promise.all([
      c.send('get_version'),
      c.send('get_all_settings'),
      c.send('get_version'),
      c.send('set_usb_charging', { level: 20 }),
    ]);
    check('all four replies returned', results.length === 4);
    check('no cross-talk between replies',
      (results[0].data as any)?.version === '1.0.0-mock' &&
      (results[1].data as any)?.laptop_type === 'NITRO' &&
      (results[3].data as any)?.level === 20,
      JSON.stringify(results.map(r => r.data)));
    c.close();
  }

  console.log('\n3. Oversized request rejected before it hits the wire');
  {
    const c = new HardwareClient(SOCK);
    let err: unknown;
    try {
      await c.send('set_per_zone_mode', { zone1: 'a'.repeat(5000) });
    } catch (e) { err = e; }
    check('rejects >4096-byte request', err instanceof HardwareError && (err as HardwareError).code === 'E2BIG',
      String(err));
    c.close();
  }

  console.log('\n4. Disruptive command: daemon dies without replying');
  {
    const c = new HardwareClient(SOCK);
    const states: string[] = [];
    c.on('state', (s: string) => states.push(s));

    const res = await c.send('set_modprobe_parameter_nitro');
    check('resolves instead of hanging or throwing', res.success === true);
    check('entered reinitializing state', states.includes('reinitializing'),
      states.join(' -> '));

    const ready = await c.waitUntilReady(10_000, 300);
    check('reconnects after the restart', ready === true);

    const after = await c.send('get_all_settings');
    check('usable again after reconnect', after.success === true);
    c.close();
  }

  console.log('\n5. Connection diagnostics');
  {
    const c = new HardwareClient('/tmp/nitrosense-does-not-exist.sock');
    let err: unknown;
    try { await c.send('get_version'); } catch (e) { err = e; }
    check('ENOENT surfaces an actionable message',
      err instanceof HardwareError && (err as HardwareError).code === 'ENOENT' &&
      /not running|sandbox/i.test((err as Error).message),
      String(err));
    c.close();
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
