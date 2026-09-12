/**
 * NitroSense key setup.
 *
 * The goal is that pressing the key on the keyboard opens this app, and that
 * the user never has to find out which scancode their model uses.
 *
 * DETECTING IT WITHOUT PRIVILEGES
 *   Reading the key directly is not an option: /dev/input/event* is
 *   root:input 0660 and a desktop user is not in `input` by default. Electron's
 *   globalShortcut cannot help either — its accelerator vocabulary has no
 *   XF86Launch* keys.
 *
 *   So instead of listening, we bind every candidate at once. Each candidate
 *   gets a GNOME custom shortcut that runs the launcher with a marker naming
 *   which candidate it was. Pressing the key therefore starts a second
 *   process, the single-instance lock hands its argv to the running app, and
 *   the marker says exactly which key fired. The losers are then unbound.
 *
 *   Cost: for a moment, four keys are bound. They all launch this same app, so
 *   the worst case if setup is abandoned is a spare shortcut, which
 *   `clearBindings` removes.
 *
 * WHY NOT THE UPSTREAM APPROACH
 *   The DAMX suite ships a root systemd unit that pgreps
 *   /opt/damx/gui/DivAcerManagerMax. That needs the suite installed at that
 *   path. A GNOME custom shortcut needs no root and no background process.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
const BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings';
const ENTRY_NAME = 'Div Acer Manager Max';

/**
 * What the NitroSense/PredatorSense key can report, as X keysyms.
 *
 * XF86Presentation first because that is what it actually is on AN515-45:
 * evdev KEY_PRESENTATION (425), scancode 0xf5, on the AT keyboard rather than
 * the Acer WMI hotkeys device. Confirmed with evtest, and it matches the
 * upstream DAMX key watcher, which greps that same code 425.
 *
 *   X keycode 433 = evdev 425 + 8
 *   /usr/share/X11/xkb/symbols/inet: key <I433> { [ XF86Presentation ] }
 *
 * The XF86Launch* entries stay because KEY_PROG1..4 is what several other
 * Predator/Nitro models report, and which one a model uses is exactly what
 * this detection exists to find out.
 */
export const CANDIDATES = [
  'XF86Presentation',
  'XF86Launch1',
  'XF86Launch2',
  'XF86Launch3',
  'XF86Launch4',
] as const;

export const MARKER = '--nitro-key=';

/**
 * Offered when the key turns out to be invisible to the OS.
 *
 * On some models — AN515-45 among them — the NitroSense key never reaches the
 * kernel at all: no WMI event, no input event. It is handled inside the EC.
 * Nothing can bind a key that produces no event, so the fallback is an
 * ordinary shortcut the user presses instead.
 */
export const FALLBACK_ACCELERATOR = '<Control><Alt>n';
export const FALLBACK_LABEL = 'Ctrl+Alt+N';

export type NitroKeyConfig = {
  /** Set once the user has either bound a key or explicitly declined. */
  decided: boolean;
  accelerator: string | null;
};

const EMPTY: NitroKeyConfig = { decided: false, accelerator: null };

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()));
  });
}

/** gsettings is absent outside GNOME-family sessions; treat that as "cannot". */
export async function available(): Promise<boolean> {
  try {
    await run('gsettings', ['get', SCHEMA, 'custom-keybindings']);
    return true;
  } catch {
    return false;
  }
}

export class NitroKey {
  #configPath: string;
  #launcher: string;
  #config: NitroKeyConfig = EMPTY;
  #loaded = false;
  /** Paths this class created, so cleanup never touches anyone else's. */
  #ours: string[] = [];

  constructor(userDataDir: string, launcher: string) {
    this.#configPath = join(userDataDir, 'nitro-key.json');
    this.#launcher = launcher;
  }

  async config(): Promise<NitroKeyConfig> {
    if (this.#loaded) return this.#config;
    try {
      this.#config = { ...EMPTY, ...JSON.parse(await readFile(this.#configPath, 'utf8')) };
    } catch {
      this.#config = { ...EMPTY };
    }
    this.#loaded = true;
    return this.#config;
  }

  async #save(next: NitroKeyConfig): Promise<void> {
    this.#config = next;
    this.#loaded = true;
    await mkdir(dirname(this.#configPath), { recursive: true });
    await writeFile(this.#configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  async #slots(): Promise<string[]> {
    const raw = await run('gsettings', ['get', SCHEMA, 'custom-keybindings']);
    // "@as []" for empty, otherwise "['/path/', '/path/']".
    const found = raw.match(/'([^']+)'/g);
    return found ? found.map((s) => s.slice(1, -1)) : [];
  }

  async #setSlots(slots: string[]): Promise<void> {
    const value = slots.length === 0 ? '@as []' : `[${slots.map((s) => `'${s}'`).join(', ')}]`;
    await run('gsettings', ['set', SCHEMA, 'custom-keybindings', value]);
  }

  async #write(path: string, name: string, command: string, binding: string): Promise<void> {
    await run('gsettings', ['set', `${CUSTOM}:${path}`, 'name', name]);
    await run('gsettings', ['set', `${CUSTOM}:${path}`, 'command', command]);
    await run('gsettings', ['set', `${CUSTOM}:${path}`, 'binding', binding]);
  }

  /** A free slot index not already registered. */
  async #freeSlots(count: number): Promise<string[]> {
    const taken = new Set(await this.#slots());
    const free: string[] = [];
    for (let i = 0; free.length < count && i < 64; i += 1) {
      const path = `${BASE}/custom${i}/`;
      if (!taken.has(path)) free.push(path);
    }
    return free;
  }

  /**
   * Bind every candidate, each tagged so we can tell which one fired.
   * Returns false when the desktop has no custom-shortcut support.
   */
  async beginDetection(): Promise<boolean> {
    if (!(await available())) return false;
    await this.clearBindings();

    const slots = await this.#freeSlots(CANDIDATES.length);
    const registered = await this.#slots();

    for (const [i, accel] of CANDIDATES.entries()) {
      const path = slots[i];
      if (!path) break;
      await this.#write(
        path,
        `${ENTRY_NAME} (detecting ${accel})`,
        `${this.#launcher} ${MARKER}${accel}`,
        accel,
      );
      registered.push(path);
      this.#ours.push(path);
    }
    await this.#setSlots(registered);
    return true;
  }

  /**
   * Keep the key that fired, drop the rest, and remember the choice.
   */
  async confirm(accelerator: string): Promise<void> {
    await this.clearBindings();
    if (await available()) {
      const [path] = await this.#freeSlots(1);
      if (path) {
        await this.#write(path, ENTRY_NAME, this.#launcher, accelerator);
        await this.#setSlots([...(await this.#slots()), path]);
        this.#ours = [path];
      }
    }
    await this.#save({ decided: true, accelerator });
  }

  /** User declined. Remember that, so the prompt does not come back. */
  async decline(): Promise<void> {
    await this.clearBindings();
    await this.#save({ decided: true, accelerator: null });
  }

  /**
   * Remove only shortcuts this app created — matched by name, so a cancelled
   * detection cannot leave four stray bindings behind, and a shortcut the user
   * made themselves is never touched.
   */
  async clearBindings(): Promise<void> {
    if (!(await available())) return;
    const slots = await this.#slots();
    const keep: string[] = [];
    for (const path of slots) {
      let name = '';
      try {
        name = await run('gsettings', ['get', `${CUSTOM}:${path}`, 'name']);
      } catch {
        // Unreadable slot: leave it alone rather than guess.
      }
      if (name.includes(ENTRY_NAME)) {
        await run('gsettings', ['reset-recursively', `${CUSTOM}:${path}`]).catch(() => undefined);
      } else {
        keep.push(path);
      }
    }
    await this.#setSlots(keep);
    this.#ours = [];
  }
}

/** Pull the marker back out of a relaunch's argv. */
export function acceleratorFromArgv(argv: string[]): string | null {
  const hit = argv.find((a) => a.startsWith(MARKER));
  if (!hit) return null;
  const value = hit.slice(MARKER.length);
  return (CANDIDATES as readonly string[]).includes(value) ? value : null;
}
