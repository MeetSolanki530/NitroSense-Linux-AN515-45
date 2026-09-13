/**
 * Tests the pure mode->target mapping in cpupower.ts. Reading/applying real
 * power state needs actual hardware (cpufreq sysfs, gdbus/pkexec), so those
 * are exercised manually via scripts/monitor-power.ts on real hardware, not
 * here — this only checks the mapping itself is correct and internally
 * consistent.
 */
import { readFileSync } from 'node:fs';
import { targetFor } from '../electron/cpupower.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n1. The three modes are genuinely distinct');
const quiet = targetFor('quiet');
const balanced = targetFor('balanced');
const performance = targetFor('performance');

check('quiet and balanced use different EPP', quiet.epp !== balanced.epp,
  `both ${quiet.epp}`);
check('balanced and performance use different governors',
  balanced.governor !== performance.governor);
check('quiet and performance are maximally different in fan behaviour',
  quiet.cpuFan !== performance.cpuFan && quiet.gpuFan !== performance.gpuFan);

console.log('\n2. Only governors this driver actually reports are used');
// Confirmed on real hardware: amd-pstate-epp exposes exactly these two.
const REAL_GOVERNORS = ['powersave', 'performance'];
check('quiet uses a real governor', REAL_GOVERNORS.includes(quiet.governor));
check('balanced uses a real governor', REAL_GOVERNORS.includes(balanced.governor));
check('performance uses a real governor', REAL_GOVERNORS.includes(performance.governor));

console.log('\n3. Only EPP values this driver actually reports are used');
// Confirmed on real hardware: energy_performance_available_preferences.
const REAL_EPP = ['default', 'performance', 'balance_performance', 'balance_power', 'power'];
check('quiet uses a real EPP value', REAL_EPP.includes(quiet.epp));
check('balanced uses a real EPP value', REAL_EPP.includes(balanced.epp));
check('performance uses a real EPP value', REAL_EPP.includes(performance.epp));

console.log('\n4. Fan targets stay within the daemon\'s accepted 0-100 range');
for (const [name, t] of Object.entries({ quiet, balanced, performance })) {
  check(`${name} cpuFan is 0-100`, t.cpuFan >= 0 && t.cpuFan <= 100);
  check(`${name} gpuFan is 0-100`, t.gpuFan >= 0 && t.gpuFan <= 100);
}

console.log('\n5. Performance mode is unambiguously the most aggressive setting');
check('performance uses the "performance" governor', performance.governor === 'performance');
check('performance uses the "performance" EPP', performance.epp === 'performance');
check('performance runs fans at maximum', performance.cpuFan === 100 && performance.gpuFan === 100);

console.log('\n6. Balanced matches this hardware\'s own observed real-world default');
// Confirmed via `cat energy_performance_preference` before any of this was
// touched: powersave / balance_performance.
check('balanced governor matches the untouched default', balanced.governor === 'powersave');
check('balanced EPP matches the untouched default', balanced.epp === 'balance_performance');

// The daemon keeps its own copy of this table, because it is what puts the
// mode back at boot: this path applies modes through pkexec, which needs a
// session to authorise it and there is none before login. Two copies of the
// same table drift, and the symptom would be a machine that boots into a
// different mode from the one the app shows. So compare them directly.
console.log('\n7. The daemon\'s copy of the table still agrees');

const daemonSrc = readFileSync(
  new URL('../../service/nitrosense-daemon.py', import.meta.url), 'utf8');

const tableMatch = daemonSrc.match(/POWER_MODE_TARGETS = \{([\s\S]*?)\n\}/);
check('the daemon still has a mode table', tableMatch !== null);

if (tableMatch) {
  for (const mode of ['quiet', 'balanced', 'performance'] as const) {
    const row = tableMatch[1]?.match(
      new RegExp(`"${mode}":\\s*\\{"governor":\\s*"([^"]+)",\\s*"epp":\\s*"([^"]+)"\\}`));
    const target = targetFor(mode);
    check(`${mode} governor agrees`, row?.[1] === target.governor,
      `daemon ${row?.[1]} vs app ${target.governor}`);
    check(`${mode} EPP agrees`, row?.[2] === target.epp,
      `daemon ${row?.[2]} vs app ${target.epp}`);
  }
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
