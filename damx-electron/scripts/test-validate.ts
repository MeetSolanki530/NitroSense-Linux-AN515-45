/**
 * Validation tests. This is the security boundary between a sandboxed
 * renderer and a root-backed daemon, so the rules are asserted directly.
 */
import {
  ValidationError, bool, fourZoneConfig, hexColor, intInRange,
  modprobeParam, nonEmptyString, powerMode, usbChargingLevel, zoneColors,
} from '../electron/validate.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}
function rejects(fn: () => unknown): boolean {
  try { fn(); return false; } catch (e) { return e instanceof ValidationError; }
}

console.log('\n1. Integer ranges (fan speed, brightness)');
check('accepts in-range', intInRange(50, 0, 100, 'x') === 50);
check('accepts boundaries', intInRange(0, 0, 100, 'x') === 0 && intInRange(100, 0, 100, 'x') === 100);
check('rejects above range', rejects(() => intInRange(101, 0, 100, 'x')));
check('rejects negative', rejects(() => intInRange(-1, 0, 100, 'x')));
check('rejects fractional', rejects(() => intInRange(50.5, 0, 100, 'x')));
check('rejects numeric string', rejects(() => intInRange('50', 0, 100, 'x')));
check('rejects NaN', rejects(() => intInRange(NaN, 0, 100, 'x')));
check('rejects Infinity', rejects(() => intInRange(Infinity, 0, 100, 'x')));

console.log('\n2. USB charging — daemon accepts only 0/10/20/30');
check('accepts 0', usbChargingLevel(0) === 0);
check('accepts 30', usbChargingLevel(30) === 30);
check('rejects 15', rejects(() => usbChargingLevel(15)));
check('rejects 100', rejects(() => usbChargingLevel(100)));
check('rejects "10"', rejects(() => usbChargingLevel('10')));

console.log('\n3. Booleans are not coerced');
check('accepts true', bool(true, 'x') === true);
check('rejects 1', rejects(() => bool(1, 'x')));
check('rejects "true"', rejects(() => bool('true', 'x')));
check('rejects null', rejects(() => bool(null, 'x')));

console.log('\n4. Hex colours');
check('accepts lowercase', hexColor('ff6a00', 'x') === 'ff6a00');
check('normalises case', hexColor('FF6A00', 'x') === 'ff6a00');
check('rejects leading #', rejects(() => hexColor('#ff6a00', 'x')));
check('rejects 3-digit shorthand', rejects(() => hexColor('f60', 'x')));
check('rejects non-hex', rejects(() => hexColor('gggggg', 'x')));
check('requires exactly 4 zones', rejects(() => zoneColors(['ff0000', '00ff00'])));
check('accepts 4 zones', zoneColors(['ff0000', '00ff00', '0000ff', 'ffffff'])[2] === '0000ff');

console.log('\n5. Four-zone config');
const ok = fourZoneConfig({ mode: 3, speed: 5, brightness: 80, direction: 2, red: 255, green: 0, blue: 128 });
check('accepts a valid config', ok.mode === 3 && ok.blue === 128);
check('rejects mode 8', rejects(() => fourZoneConfig({ ...ok, mode: 8 })));
check('rejects speed 10', rejects(() => fourZoneConfig({ ...ok, speed: 10 })));
check('rejects direction 0', rejects(() => fourZoneConfig({ ...ok, direction: 0 })));
check('rejects rgb 256', rejects(() => fourZoneConfig({ ...ok, red: 256 })));

console.log('\n6. Modprobe parameters and strings');
check('accepts nitro_v4', modprobeParam('nitro_v4') === 'nitro_v4');
check('rejects arbitrary parameter', rejects(() => modprobeParam('rm -rf /')));
check('rejects empty string', rejects(() => nonEmptyString('', 'profile')));
check('rejects non-string profile', rejects(() => nonEmptyString(42, 'profile')));

console.log('\n7. Real power mode (governor+EPP, replaces the dead thermal_profile)');
check('accepts quiet', powerMode('quiet') === 'quiet');
check('accepts balanced', powerMode('balanced') === 'balanced');
check('accepts performance', powerMode('performance') === 'performance');
check('rejects a daemon-style profile name', rejects(() => powerMode('low-power')));
check('rejects garbage', rejects(() => powerMode('turbo')));
check('rejects non-string', rejects(() => powerMode(1)));

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
