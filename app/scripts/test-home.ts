/**
 * Pure-logic tests for the Home view helpers and gauge geometry.
 * Rendering is verified separately by scripts/smoke.sh.
 */
import { arcPath, fraction, ticks } from '../src/components/geometry.ts';
import { fanLabel, prettyMode, profileUnreadable } from '../src/views/homeFormat.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n1. Gauge geometry');
check('fraction clamps below range', fraction(-20, 0, 100) === 0);
check('fraction clamps above range', fraction(500, 0, 100) === 1);
check('fraction interpolates', fraction(50, 0, 100) === 0.5);
check('fraction survives a zero-width range', fraction(5, 10, 10) === 0);
check('arcPath emits a move and an arc', /^M [\d.-]+ [\d.-]+ A /.test(arcPath(50, 50, 40, 135, 405)));
check('full circle does not collapse to a point',
  arcPath(50, 50, 40, 0, 360) !== arcPath(50, 50, 40, 0, 0));

const t = ticks(50, 50, 48, 40, 135, 405, 10, 0.5);
check('tick count is honoured', t.length === 10, String(t.length));
// count=10 spans t = i/9, so t <= 0.5 lights i = 0..4.
check('ticks light up to the value', t.filter((x) => x.lit).length === 5,
  String(t.filter((x) => x.lit).length));
check('no ticks lit at zero', ticks(50, 50, 48, 40, 0, 360, 10, 0).filter((x) => x.lit).length === 1);

console.log('\n2. Mode labels (kernel names are not presentation text)');
// This machine reports five profiles; every label must be distinct or the
// tiles become indistinguishable.
const REAL = ['low-power', 'quiet', 'balanced', 'balanced-performance', 'performance'];
const labels = REAL.map(prettyMode);
check('all five real profiles get distinct labels',
  new Set(labels).size === REAL.length, labels.join(', '));
check('low-power is not confused with quiet',
  prettyMode('low-power') !== prettyMode('quiet'));
check('performance is not confused with balanced-performance',
  prettyMode('performance') !== prettyMode('balanced-performance'));
check('balanced reads as Balanced', prettyMode('balanced') === 'Balanced');
check('quiet reads as Quiet', prettyMode('quiet') === 'Quiet');
check('unknown kernel name is title-cased, not dropped',
  prettyMode('some_new-mode') === 'Some new mode', prettyMode('some_new-mode'));
check('missing profile does not render blank', prettyMode(undefined) === 'Unknown');

console.log('\n3. Fan label (0,0 means automatic, not stopped)');
check('0/0 reads as Auto', fanLabel({ fan_speed: { cpu: '0', gpu: '0' } }) === 'Auto');
check('manual speeds are shown', fanLabel({ fan_speed: { cpu: '60', gpu: '70' } }) === '60% / 70%');
check('absent fan_speed renders --', fanLabel({}) === '--');
check('null settings render --', fanLabel(null) === '--');
check('garbage values render -- rather than NaN',
  fanLabel({ fan_speed: { cpu: 'x', gpu: 'y' } }) === '--');

console.log('\n4. Unreadable current profile');
check('choices present but no current means unreadable',
  profileUnreadable('', ['balanced', 'performance']) === true);
check('a real current profile is readable',
  profileUnreadable('balanced', ['balanced', 'performance']) === false);
check('no choices at all is not "unreadable"',
  profileUnreadable('', []) === false);
check('undefined current with choices is unreadable',
  profileUnreadable(undefined, ['balanced']) === true);

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
