/**
 * Keyboard lighting parser tests.
 * Formats come straight from the daemon's sysfs writes:
 *   per_zone_mode  "z1,z2,z3,z4,brightness"
 *   four_zone_mode "mode,speed,brightness,direction,red,green,blue"
 */
import {
  DEFAULT_EFFECT_SPEED, EFFECTS, describeLighting, effectFor, hexToRgb,
  normaliseHex, parseFourZone, parsePerZone, rgbToHex, usesAnimation,
  usesColour, usesDirection, withUsableSpeed,
} from '../src/state/keyboard.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n1. Hex handling');
check('accepts bare hex', normaliseHex('ff6a00') === 'ff6a00');
check('strips a leading #', normaliseHex('#FF6A00') === 'ff6a00');
check('rejects 3-digit shorthand', normaliseHex('f60') === null);
check('rejects non-hex', normaliseHex('zzzzzz') === null);
check('hexToRgb splits channels', JSON.stringify(hexToRgb('ff6a00')) === '{"red":255,"green":106,"blue":0}');
check('rgbToHex pads single digits', rgbToHex(0, 10, 255) === '000aff');
check('rgbToHex clamps out-of-range', rgbToHex(300, -5, 128) === 'ff0080');
check('hex round-trips', rgbToHex(...Object.values(hexToRgb('4287f5')!) as [number, number, number]) === '4287f5');

console.log('\n2. per_zone_mode parsing');
const pz = parsePerZone('ff0000,00ff00,0000ff,ffffff,80');
check('parses four zones', pz?.zones.join(',') === 'ff0000,00ff00,0000ff,ffffff', JSON.stringify(pz));
check('parses brightness', pz?.brightness === 80);
check('tolerates whitespace and newline', parsePerZone(' ff0000, 00ff00 ,0000ff,ffffff, 55 \n')?.brightness === 55);
check('clamps brightness above 100', parsePerZone('ff0000,00ff00,0000ff,ffffff,400')?.brightness === 100);
check('rejects too few fields', parsePerZone('ff0000,00ff00,50') === null);
check('rejects an invalid zone colour', parsePerZone('xxxxxx,00ff00,0000ff,ffffff,80') === null);
check('rejects a non-string', parsePerZone(undefined) === null);
check('rejects empty', parsePerZone('') === null);

console.log('\n3. four_zone_mode parsing');
const fz = parseFourZone('3,7,90,2,255,106,0');
check('parses mode', fz?.mode === 3);
check('parses speed', fz?.speed === 7);
check('parses brightness', fz?.brightness === 90);
check('parses direction', fz?.direction === 2);
check('parses rgb', fz?.red === 255 && fz?.green === 106 && fz?.blue === 0);
check('clamps mode above 5', parseFourZone('99,5,50,1,0,0,0')?.mode === 5);
check('clamps speed above 9', parseFourZone('0,50,50,1,0,0,0')?.speed === 9);
check('falls back to direction 1 when invalid', parseFourZone('0,5,50,9,0,0,0')?.direction === 1);
check('clamps rgb above 255', parseFourZone('0,5,50,1,999,0,0')?.red === 255);
check('rejects too few fields', parseFourZone('0,5,50') === null);
check('rejects non-numeric fields', parseFourZone('a,b,c,d,e,f,g') === null);

console.log('\n4. Effect semantics (what the firmware honours)');
check('six effects are exposed', EFFECTS.length === 6);
check('mode 0 is Static', EFFECTS[0]?.name === 'Static');
check('mode 5 is Zoom', EFFECTS[5]?.name === 'Zoom');
check('Static ignores speed', usesAnimation(0) === false);
check('Breathing uses speed', usesAnimation(1) === true);
check('Neon uses speed', usesAnimation(2) === true);

console.log('\n4b. An animated effect is never applied at speed 0');
// Static is stored with speed 0 and the driver writes that back, so it is
// what the next read returns. Carrying it into an animated effect asks the
// firmware to animate at zero speed, which looks exactly like a dead effect.
const fromStatic = { mode: 0, speed: 0, brightness: 100, direction: 1,
                     red: 255, green: 0, blue: 0 };
check('static keeps speed 0', withUsableSpeed(fromStatic).speed === 0);
check('breathing inherits a usable speed',
  withUsableSpeed({ ...fromStatic, mode: 1 }).speed === DEFAULT_EFFECT_SPEED);
check('wave inherits a usable speed',
  withUsableSpeed({ ...fromStatic, mode: 3 }).speed === DEFAULT_EFFECT_SPEED);
check('a speed the user chose is left alone',
  withUsableSpeed({ ...fromStatic, mode: 1, speed: 2 }).speed === 2);
check('nothing else is altered',
  withUsableSpeed({ ...fromStatic, mode: 1 }).red === 255);
check('Shifting uses speed', usesAnimation(4) === true);

check('Wave uses direction', usesDirection(3) === true);
check('Shifting uses direction', usesDirection(4) === true);
check('Static does not use direction', usesDirection(0) === false);
check('Breathing does not use direction', usesDirection(1) === false);
check('Zoom does not use direction', usesDirection(5) === false);

check('Neon discards colour', usesColour(2) === false);
check('Wave discards colour', usesColour(3) === false);
check('Static uses colour', usesColour(0) === true);
check('Shifting uses colour', usesColour(4) === true);
check('unknown mode falls back to Static', effectFor(99).name === 'Static');

// The preview draws one lighting state from two reads, and only one of them
// describes the hardware at a time. Getting this wrong is what made a keyboard
// breathing green show as four white blocks: per_zone_mode reports ffffff
// after any effect write, and the preview drew it unconditionally.
console.log('\n7. Preview reflects what is actually lit');

const zonesRGBY = {
  zones: ['ff0000', '00ff00', '0000ff', 'ffff00'] as [string, string, string, string],
  brightness: 60,
};
const staticFZ = { mode: 0, speed: 0, brightness: 100, direction: 1,
                   red: 0, green: 0, blue: 0 };

const asStatic = describeLighting(zonesRGBY, staticFZ);
check('static shows the four zone colours',
  asStatic.swatches.join() === '#ff0000,#00ff00,#0000ff,#ffff00');
check('static takes per-zone brightness', asStatic.brightness === 60);
check('static glow matches its swatch', asStatic.glows[0] === '#ff0000');

// Breathing blue, while per-zone still reports the stale red/green/blue/yellow.
const breathing = describeLighting(zonesRGBY,
  { mode: 1, speed: 7, brightness: 80, direction: 1, red: 0, green: 0, blue: 255 });
check('an effect overrides the stale per-zone colours',
  breathing.swatches.every((s) => s === '#0000ff'));
check('an effect takes its own brightness', breathing.brightness === 80);
check('the effect is named in the caption', breathing.caption.startsWith('Breathing at speed 7'));
check('a non-directional effect omits direction',
  !breathing.caption.includes('right to left'));

// Neon and Wave generate their own colours, so no single swatch is honest.
const neon = describeLighting(zonesRGBY,
  { mode: 2, speed: 4, brightness: 100, direction: 1, red: 255, green: 0, blue: 0 });
check('an own-colour effect ignores the picked colour',
  neon.swatches.every((s) => s.startsWith('linear-gradient')));
check('an own-colour effect still has a plain glow colour',
  neon.glows.every((g) => /^#[0-9a-f]{6}$/i.test(g)));
check('an own-colour effect says so', neon.caption.includes('cycles its own colours'));

// A gradient in box-shadow is silently dropped, so glows must never be one.
check('no glow is ever a gradient',
  [asStatic, breathing, neon].every((p) => p.glows.every((g) => !g.includes('gradient'))));

const wave = describeLighting(zonesRGBY,
  { mode: 3, speed: 5, brightness: 100, direction: 2, red: 0, green: 0, blue: 0 });
check('a directional effect names its direction', wave.caption.includes('left to right'));
const waveBack = describeLighting(zonesRGBY,
  { mode: 3, speed: 5, brightness: 100, direction: 1, red: 0, green: 0, blue: 0 });
check('the other direction reads the other way',
  waveBack.caption.includes('right to left'));

check('every preview fills exactly four zones',
  [asStatic, breathing, neon, wave].every((p) => p.swatches.length === 4 && p.glows.length === 4));

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);
