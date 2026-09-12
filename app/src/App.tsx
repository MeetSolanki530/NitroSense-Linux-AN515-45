import { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { NitroKeySetup } from './components/NitroKeySetup';
import type { Tab } from './components/TitleBar';
import { Home } from './views/Home';
import { Performance } from './views/Performance';
import { Battery } from './views/Battery';
import { Keyboard } from './views/Keyboard';
import { Internals } from './views/Internals';
import { Monitoring } from './views/Monitoring';
import { useConnection, useSettings, useTelemetry } from './state/hardware';
import './components/TitleBar.css';
import './App.css';
import type { JSX } from 'react';

const TABS: Tab[] = [
  { id: 'home', label: 'Home' },
  { id: 'performance', label: 'Performance' },
  { id: 'battery', label: 'Battery' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'internals', label: 'Internals' },
];

export function App(): JSX.Element {
  // Deep link: #performance selects that tab on load, which lets headless
  // captures target a specific view.
  const initialTab = typeof location !== 'undefined' && location.hash
    ? location.hash.replace('#', '')
    : 'home';
  const [active, setActive] = useState(
    TABS.some((t) => t.id === initialTab) ? initialTab : 'home',
  );
  const connection = useConnection();
  const telemetry = useTelemetry();
  const { settings, error, has, refresh } = useSettings();

  // Mode drives the accent colour app-wide (red at Performance, amber at
  // Balanced), matching the screenshots.
  const mode = settings?.thermal_profile?.current ?? 'balanced';
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  const banner = useMemo(() => {
    if (connection === 'reinitializing') {
      return { kind: 'warn', text: 'Driver and daemon are restarting. This takes around 10 seconds.' };
    }
    if (connection === 'disconnected') {
      return {
        kind: 'danger',
        text:
          error ??
          'Cannot reach the hardware service. Temperatures still work; fan, battery and '
          + 'lighting controls are unavailable.',
      };
    }
    return null;
  }, [connection, error]);

  return (
    <div className="app-shell">
      <TitleBar tabs={TABS} active={active} onSelect={setActive} connection={connection} />

      {/* Asked once on first run, then never again. */}
      <NitroKeySetup />

      {banner && <div className={`banner banner-${banner.kind}`}>{banner.text}</div>}

      <main className="app-body">
        {active === 'home' && <Home telemetry={telemetry} settings={settings} has={has} />}
        {active === 'performance' && (
          <Performance settings={settings} telemetry={telemetry} has={has}
            connection={connection} refresh={refresh} />
        )}
        {active === 'battery' && (
          <Battery settings={settings} telemetry={telemetry} has={has}
            connection={connection} refresh={refresh} />
        )}
        {active === 'keyboard' && (
          <Keyboard settings={settings} has={has} connection={connection} refresh={refresh} />
        )}
        {active === 'monitoring' && <Monitoring telemetry={telemetry} />}
        {active === 'internals' && (
          <Internals connection={connection} refresh={refresh} />
        )}

      </main>
    </div>
  );
}
