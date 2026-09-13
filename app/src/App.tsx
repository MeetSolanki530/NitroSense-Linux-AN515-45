import { useEffect, useMemo, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { NitroKeySetup } from './components/NitroKeySetup';
import { ServiceGate } from './components/ServiceGate';
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

  /**
   * Whether to take over the window instead of showing the dashboard.
   *
   * Every control here needs the service, so there is nothing to fall back to
   * and no way past this screen except getting it running.
   *
   * The `everConnected` part is what stops the window flashing on launch. The
   * connection starts as 'connecting', and rendering the dashboard during that
   * means a fully drawn interface appears for a moment and is then replaced
   * the instant the state resolves to 'disconnected'. Holding the gate up
   * until the first resolution means the user sees one screen, not two.
   *
   * Once it has connected at least once, a later 'connecting' is a reconnect
   * rather than a cold start, and those are covered by the banner instead so a
   * blip does not throw the whole window away.
   */
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (connection === 'connected') setEverConnected(true);
  }, [connection]);

  const showGate =
    connection === 'disconnected' || (!everConnected && connection === 'connecting');

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
      {/* Tabs are hidden while the gate is up. Every section behind them needs
          the service, so offering navigation to six dead screens would only
          invite the user to go and find out. */}
      <TitleBar
        tabs={TABS}
        active={active}
        onSelect={setActive}
        connection={connection}
        showTabs={!showGate}
      />

      {/* Asked once on first run, then never again. Held back while the gate
          is up: two things asking for attention at once, one of them about a
          keyboard shortcut, is not the first thing to deal with when the
          service is down. */}
      {!showGate && <NitroKeySetup />}

      {showGate ? (
        <ServiceGate connection={connection} />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
