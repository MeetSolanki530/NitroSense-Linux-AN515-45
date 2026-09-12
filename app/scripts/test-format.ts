/**
 * Setting-value parsing tests.
 *
 * The central rule: an unreadable value must be "unknown", never a confident
 * "off". A toggle showing off for a feature it cannot read misrepresents the
 * hardware.
 */
import {
  batterySummary, isUnsupported, settingBool, settingUnsupported, toBool, usbLabel, usbLevel,
} from '../src/state/format.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n1. Sysfs booleans');
check('"1" is true', toBool('1') === true);
check('"0" is false', toBool('0') === false);
check('trailing whitespace is tolerated', toBool(' 1 ') === true);
check('"true"/"enabled" are accepted', toBool('true') === true && toBool('enabled') === true);
check('"off"/"disabled" are accepted', toBool('off') === false && toBool('disabled') === false);
check('real booleans pass through', toBool(true) === true);
check('empty string is unknown, not false', toBool('') === null);
check('garbage is unknown, not false', toBool('maybe') === null);
check('undefined is unknown', toBool(undefined) === null);
check('null is unknown', toBool(null) === null);

console.log('\n2. settingBool distinguishes absent from off');
check('absent key is unknown', settingBool({}, 'lcd_override') === null);
check('null settings are unknown', settingBool(null, 'lcd_override') === null);
check('present "0" is false', settingBool({ lcd_override: '0' }, 'lcd_override') === false);
check('present "1" is true', settingBool({ lcd_override: '1' }, 'lcd_override') === true);

console.log('\n2b. -1 is a GET-decode gap, not "unimplemented" — SET still works');
check('"-1" is recognised by the detector', isUnsupported('-1') === true);
check('"0" is not flagged', isUnsupported('0') === false);
check('"1" is not flagged', isUnsupported('1') === false);
// This is the whole point of the fix: -1 must fall back to the SAME
// "unknown" tri-state as any other unparseable value, so the toggle stays
// enabled (Toggle.tsx no longer has a separate disabling "unsupported"
// path — only value === null, which -1 already produces here).
check('"-1" reads as unknown, same as any other unparseable value', toBool('-1') === null);
check('detector finds it in settings', settingUnsupported({ lcd_override: '-1' }, 'lcd_override') === true);
check('a real value is not flagged', settingUnsupported({ lcd_override: '0' }, 'lcd_override') === false);
check('an absent key is not flagged', settingUnsupported({}, 'lcd_override') === false);

console.log('\n3. USB charging level');
check('reads 10', usbLevel({ usb_charging: '10' }) === 10);
check('reads 0', usbLevel({ usb_charging: '0' }) === 0);
check('rejects an off-grid value', usbLevel({ usb_charging: '15' }) === null);
check('absent is null', usbLevel({}) === null);
check('garbage is null', usbLevel({ usb_charging: 'x' }) === null);
check('0 renders as Off', usbLabel(0) === 'Off');
check('30 renders as 30%', usbLabel(30) === '30%');
check('null renders as --', usbLabel(null) === '--');

console.log('\n4. Battery summary');
check('percent with status', batterySummary(84, 'Charging', true) === '84% · Charging');
check('falls back to AC when status is absent', batterySummary(84, null, true) === '84% · AC');
check('falls back to Battery on DC', batterySummary(84, null, false) === '84% · Battery');
check('unknown percent renders --', batterySummary(null, 'Charging', true) === '--');

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
