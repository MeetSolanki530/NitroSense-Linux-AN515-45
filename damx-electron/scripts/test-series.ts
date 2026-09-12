/**
 * Chart series tests — the gap and alignment rules that keep the Monitoring
 * charts from lying about the hardware.
 */
import { autoRange, buildSegments, latestReading } from '../src/components/series.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

const opts = { width: 100, height: 50, max: 100, capacity: 5 };
const xs = (seg: string): number[] => seg.split(' ').map((p) => Number(p.split(',')[0]));
const ys = (seg: string): number[] => seg.split(' ').map((p) => Number(p.split(',')[1]));

console.log('\n1. Nulls break the line instead of plotting as zero');
const gapped = buildSegments([10, 20, null, 40, 50], opts);
check('a null splits the series in two', gapped.length === 2, `${gapped.length} segments`);
check('no point sits at the zero baseline', !gapped.some((s) => ys(s).includes(50)),
  JSON.stringify(gapped));
check('an all-null series draws nothing', buildSegments([null, null, null], opts).length === 0);
check('a single reading draws nothing (needs two points)',
  buildSegments([null, 42, null], opts).length === 0);
check('NaN is treated as a gap', buildSegments([10, NaN, 30], opts).length === 0);

console.log('\n2. Series are right-anchored so times line up');
const full = buildSegments([0, 25, 50, 75, 100], opts);
const short = buildSegments([75, 100], opts);
check('a full series spans the width', xs(full[0] as string).at(-1) === 100);
check('a short series still ends at the right edge',
  xs(short[0] as string).at(-1) === 100, JSON.stringify(short));
check('a short series starts partway in, not at zero',
  (xs(short[0] as string)[0] ?? 0) === 75, JSON.stringify(short));
check('newest samples of different-length series share a column',
  xs(full[0] as string).at(-1) === xs(short[0] as string).at(-1));

console.log('\n3. Scaling');
check('zero maps to the bottom', ys(full[0] as string)[0] === 50);
check('max maps to the top', ys(full[0] as string).at(-1) === 0);
check('values above max are clamped, not drawn off-chart',
  ys(buildSegments([200, 200], opts)[0] as string)[0] === 0);
check('negative values are clamped to the baseline',
  ys(buildSegments([-50, -50], opts)[0] as string)[0] === 50);
check('empty input is safe', buildSegments([], opts).length === 0);
check('capacity of 1 is safe', buildSegments([1, 2], { ...opts, capacity: 1 }).length === 0);

console.log('\n4. Latest reading');
check('finds the last real value', latestReading([1, 2, 3]) === 3);
check('skips trailing nulls', latestReading([1, 2, null, null]) === 2);
check('all-null returns null', latestReading([null, null]) === null);
check('empty returns null', latestReading([]) === null);

console.log('\n5. Auto-scaled range (clustered temperature readings)');
{
  // Real-world case that motivated this: CPU/GPU/iGPU/System all sitting
  // between 47-52 on a 0-100 scale, indistinguishable near the top.
  const clustered = autoRange([[47, 48], [51, 52], [48], [51]], 100);
  check('range is tighter than the full 0-100 scale',
    clustered.max - clustered.min < 100, JSON.stringify(clustered));
  check('range contains every reading',
    clustered.min <= 47 && clustered.max >= 52, JSON.stringify(clustered));

  const noData = autoRange([[], [null, null]], 100);
  check('no data falls back to [0, fallbackMax]',
    noData.min === 0 && noData.max === 100, JSON.stringify(noData));

  const flat = autoRange([[50, 50, 50]], 100);
  check('a perfectly flat series still gets a visible span',
    flat.max - flat.min >= 10, JSON.stringify(flat));

  const nearZero = autoRange([[1, 2]], 100);
  check('range never goes negative for low readings',
    nearZero.min >= 0, JSON.stringify(nearZero));

  const nearMax = autoRange([[98, 99]], 100);
  check('range never exceeds fallbackMax for high readings',
    nearMax.max <= 100, JSON.stringify(nearMax));

  const wide = autoRange([[10, 90]], 100);
  check('a genuinely wide spread is not artificially narrowed',
    wide.min <= 10 && wide.max >= 90, JSON.stringify(wide));
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
