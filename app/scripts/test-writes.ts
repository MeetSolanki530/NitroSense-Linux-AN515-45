/**
 * End-to-end write tests.
 *
 * Launches the real Electron app against the mock daemon and drives writes
 * from the renderer, so the whole chain is exercised: window.nitrosense ->
 * contextBridge -> ipc validation in main -> socket -> daemon -> reconcile.
 * Asserts against the daemon's own state afterwards, not the UI's optimism.
 */
import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SOCK = '/tmp/nitrosense-write-test.sock';
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Run a snippet inside the renderer and return its JSON result. */
function runInRenderer(code: string): Promise<unknown> {
  const encoded = Buffer.from(code, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NITROSENSE_SOCKET: SOCK };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    execFile(
      'npx',
      ['electron', '.', '--no-sandbox', `--smoke-eval=${encoded}`],
      { env, timeout: 60_000 },
      (err, stdout) => {
        const line = stdout.split('\n').find((l) => l.startsWith('[eval] '));
        const errLine = stdout.split('\n').find((l) => l.startsWith('[eval-error] '));
        if (errLine) return reject(new Error(errLine));
        if (!line) return reject(err ?? new Error(`no result\n${stdout}`));
        resolve(JSON.parse(line.slice('[eval] '.length)));
      },
    );
  });
}

async function main(): Promise<void> {
  // Started unforced: the internals test needs the thin-feature starting
  // state, and every other section forces what it needs first.
  const mock = spawn('python3', ['scripts/mock-daemon.py', SOCK], {
    stdio: 'ignore', detached: false,
  });
  await sleep(1200);

  try {
    console.log('\n0. Unlock features (mock starts unforced, like an AN515-45)');
    const r0 = (await runInRenderer(`
      (async () => {
        const before = (await window.nitrosense.getSettings()).available_features.length;
        await window.nitrosense.forceModel('nitro_v4');
        const after = (await window.nitrosense.getSettings()).available_features.length;
        return { before, after };
      })()
    `)) as { before: number; after: number };
    check('starts with one feature', r0.before === 1, String(r0.before));
    check('forcing nitro_v4 unlocks the rest', r0.after === 10, String(r0.after));

    console.log('\n1. Thermal profile write is accepted and reconciled');
    const r1 = (await runInRenderer(`
      (async () => {
        const before = await window.nitrosense.getSettings();
        await window.nitrosense.setThermalProfile('performance');
        const after = await window.nitrosense.getSettings();
        return { before: before.thermal_profile.current, after: after.thermal_profile.current };
      })()
    `)) as { before: string; after: string };
    check('starts balanced', r1.before === 'balanced', r1.before);
    check('daemon reports performance after the write', r1.after === 'performance', r1.after);

    console.log('\n2. Invalid values are rejected before reaching the daemon');
    const r2 = (await runInRenderer(`
      (async () => {
        const out = {};
        for (const [k, fn] of Object.entries({
          badProfile: () => window.nitrosense.setThermalProfile('ludicrous'),
          badUsb:     () => window.nitrosense.setUsbCharging(15),
          badFan:     () => window.nitrosense.setFanSpeed(150, 0),
          badBool:    () => window.nitrosense.setLcdOverride('yes'),
        })) {
          try { await fn(); out[k] = 'ACCEPTED'; }
          catch (e) { out[k] = e.message; }
        }
        const after = await window.nitrosense.getSettings();
        return { out, profile: after.thermal_profile.current };
      })()
    `)) as { out: Record<string, string>; profile: string };
    check('rejects an unsupported profile', r2.out.badProfile !== 'ACCEPTED', r2.out.badProfile);
    check('rejects usb level 15', /0, 10, 20, 30/.test(r2.out.badUsb ?? ''), r2.out.badUsb);
    check('rejects fan 150', /between 0 and 100/.test(r2.out.badFan ?? ''), r2.out.badFan);
    check('rejects a string where a boolean is required',
      /must be a boolean/.test(r2.out.badBool ?? ''), r2.out.badBool);
    check('state unchanged after rejections', r2.profile === 'performance', r2.profile);

    console.log('\n3. Fan speed round-trips');
    const r3 = (await runInRenderer(`
      (async () => {
        await window.nitrosense.setFanSpeed(70, 55);
        const manual = await window.nitrosense.getSettings();
        await window.nitrosense.setFanSpeed(0, 0);
        const auto = await window.nitrosense.getSettings();
        return { manual: manual.fan_speed, auto: auto.fan_speed };
      })()
    `)) as { manual: { cpu: string; gpu: string }; auto: { cpu: string; gpu: string } };
    check('manual duty cycle is stored', r3.manual.cpu === '70' && r3.manual.gpu === '55',
      JSON.stringify(r3.manual));
    check('0/0 returns the fans to automatic', r3.auto.cpu === '0' && r3.auto.gpu === '0',
      JSON.stringify(r3.auto));

    console.log('\n4. Toggles round-trip through the daemon');
    const r5 = (await runInRenderer(`
      (async () => {
        await window.nitrosense.setBatteryLimiter(false);
        const off = await window.nitrosense.getSettings();
        await window.nitrosense.setBatteryLimiter(true);
        const on = await window.nitrosense.getSettings();
        await window.nitrosense.setLcdOverride(true);
        await window.nitrosense.setBootAnimationSound(false);
        await window.nitrosense.setBacklightTimeout(true);
        await window.nitrosense.setUsbCharging(30);
        const final = await window.nitrosense.getSettings();
        return {
          limiterOff: off.battery_limiter,
          limiterOn: on.battery_limiter,
          lcd: final.lcd_override,
          boot: final.boot_animation_sound,
          backlight: final.backlight_timeout,
          usb: final.usb_charging,
        };
      })()
    `)) as Record<string, string>;
    check('limiter turns off', r5.limiterOff === '0', r5.limiterOff);
    check('limiter turns back on', r5.limiterOn === '1', r5.limiterOn);
    check('lcd override set', r5.lcd === '1', r5.lcd);
    check('boot animation cleared', r5.boot === '0', r5.boot);
    check('backlight timeout set', r5.backlight === '1', r5.backlight);
    check('usb charging set to 30', r5.usb === '30', r5.usb);

    console.log('\n5. Keyboard lighting round-trips');
    const r7 = (await runInRenderer(`
      (async () => {
        const out = {};
        await window.nitrosense.setPerZoneMode(['112233','445566','778899','aabbcc'], 75);
        out.perZone = (await window.nitrosense.getSettings()).per_zone_mode;
        await window.nitrosense.setFourZoneMode({ mode: 3, speed: 7, brightness: 90,
                                            direction: 2, red: 255, green: 106, blue: 0 });
        out.fourZone = (await window.nitrosense.getSettings()).four_zone_mode;
        try { await window.nitrosense.setPerZoneMode(['#112233','445566','778899','aabbcc'], 75); out.hashZone = 'ACCEPTED'; }
        catch (e) { out.hashZone = e.message; }
        try { await window.nitrosense.setPerZoneMode(['112233','445566'], 75); out.shortZones = 'ACCEPTED'; }
        catch (e) { out.shortZones = e.message; }
        try { await window.nitrosense.setFourZoneMode({ mode: 9, speed: 1, brightness: 50,
                                                  direction: 1, red: 0, green: 0, blue: 0 }); out.badMode = 'ACCEPTED'; }
        catch (e) { out.badMode = e.message; }
        out.after = (await window.nitrosense.getSettings()).per_zone_mode;
        return out;
      })()
    `)) as Record<string, string>;
    check('per-zone colours round-trip',
      r7.perZone === '112233,445566,778899,aabbcc,75', r7.perZone);
    check('four-zone effect round-trips', r7.fourZone === '3,7,90,2,255,106,0', r7.fourZone);
    check('rejects a "#"-prefixed zone colour', /hex colour/.test(r7.hashZone ?? ''), r7.hashZone);
    check('rejects fewer than four zones', /exactly 4/.test(r7.shortZones ?? ''), r7.shortZones);
    check('rejects effect mode 9', /between 0 and 5/.test(r7.badMode ?? ''), r7.badMode);
    check('state unchanged after rejections',
      r7.after === '112233,445566,778899,aabbcc,75', r7.after);

    console.log('\n6. Internals: disruptive command, disconnect, reconnect, diff');
    const r8 = (await runInRenderer(`
      (async () => {
        // Earlier sections already forced the driver, so clear it first —
        // otherwise the diff below would be measuring nothing.
        await window.nitrosense.removeParameter();
        const before = await window.nitrosense.internalsState();
        // The daemon kills itself mid-request here; the client must treat the
        // dropped connection as expected and reconnect on its own.
        const result = await window.nitrosense.persistParameter('nitro_v4');
        const after = await window.nitrosense.internalsState();
        let rejected = null;
        try { await window.nitrosense.forceModel('rm -rf /'); }
        catch (e) { rejected = e.message; }
        return {
          beforeFeatures: before.features.length,
          beforeParam: before.modprobeParameter,
          daemonReturned: result.daemonReturned,
          ok: result.ok,
          gained: result.diff ? result.diff.gained.length : -1,
          lost: result.diff ? result.diff.lost.length : -1,
          afterFeatures: after.features.length,
          afterParam: after.modprobeParameter,
          afterType: after.laptopType,
          rejected,
        };
      })()
    `)) as Record<string, unknown>;
    check('starts unforced with a thin feature set', r8.beforeFeatures === 1, String(r8.beforeFeatures));
    check('starts with no modprobe parameter', r8.beforeParam === '', String(r8.beforeParam));
    check('daemon came back after restarting itself', r8.daemonReturned === true);
    check('operation reported ok', r8.ok === true);
    check('features were gained', r8.gained === 9, String(r8.gained));
    check('nothing was lost', r8.lost === 0, String(r8.lost));
    check('parameter is now persistent', r8.afterParam === 'nitro_v4', String(r8.afterParam));
    check('laptop type is now detected', r8.afterType === 'NITRO', String(r8.afterType));
    check('rejects an arbitrary modprobe parameter',
      /must be one of/.test(String(r8.rejected)), String(r8.rejected));

    console.log('\n7. Unknown methods are unreachable from the renderer');
    const r6 = (await runInRenderer(`
      (async () => ({
        keys: Object.keys(window.nitrosense).length,
        hasRawSend: typeof window.nitrosense.send,
        hasInvoke: typeof window.nitrosense.invoke,
        hasRequire: typeof window.require,
        hasProcess: typeof window.process,
      }))()
    `)) as Record<string, unknown>;
    check('no generic send() is exposed', r6.hasRawSend === 'undefined');
    check('no generic invoke() is exposed', r6.hasInvoke === 'undefined');
    check('renderer has no require()', r6.hasRequire === 'undefined');
    check('renderer has no process', r6.hasProcess === 'undefined');
  } finally {
    mock.kill();
  }

  console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
