import { useEffect, useRef, useState } from 'react';
import { MSG, Phase, type Appearance } from '@wobble/shared';
import { net, useNet, type RoomSnap } from './net/Net';
import { profileStore, useStore } from './state/store';
import { audio } from './audio/Audio';
import { Btn, ToastProvider, useToast } from './ui/components/common';
import { Home, type HomeAction } from './ui/screens/Home';
import { NameEntry } from './ui/screens/NameEntry';
import { Garage } from './ui/screens/Garage';
import { CreateRoom, RoomBrowser, type CreateOpts } from './ui/screens/Rooms';
import { Lobby } from './ui/screens/Lobby';
import { Race } from './ui/screens/Race';
import { Results } from './ui/screens/Results';
import { SettingsPanel } from './ui/screens/SettingsPanel';

type MenuScreen = 'home' | 'name' | 'browse' | 'create' | 'garage';
type Pending = 'quick' | 'create' | 'browse' | 'practice' | null;

function AppInner() {
  const toast = useToast();
  const profile = useStore(profileStore);
  const { snap, status, myId, error } = useNet();
  const [screen, setScreen] = useState<MenuScreen>('home');
  const [pending, setPending] = useState<Pending>(null);
  const [garageTab, setGarageTab] = useState<'car' | 'driver'>('car');
  const [garageInRoom, setGarageInRoom] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [results, setResults] = useState<RoomSnap | null>(null);
  const resultsRace = useRef(-1);
  const [busy, setBusy] = useState(false);

  // Resume a session after a page reload (within the reconnection window).
  useEffect(() => { void net.tryResume(); }, []);

  useEffect(() => net.onServerError((e) => { if (e.code !== 'rate_limited') toast(e.message, 'error'); }), [toast]);
  useEffect(() => { if (error) { toast(error, 'error'); net.dismissError(); } }, [error, toast]);

  // Keep a frozen copy of results so players can read them even after the room returns to the lobby.
  useEffect(() => {
    if (snap?.phase === Phase.RESULTS && resultsRace.current !== snap.raceId) {
      resultsRace.current = snap.raceId;
      setResults(snap);
    }
  }, [snap]);
  useEffect(() => { if (!snap) { setResults(null); setGarageInRoom(false); } }, [snap]);

  const inRace = snap && (snap.phase === Phase.COUNTDOWN || snap.phase === Phase.RACING) && !results;
  useEffect(() => { audio.setMusic(inRace ? 'race' : 'menu'); }, [inRace]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); setScreen('home'); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const doPending = (p: Pending, name: string) => {
    if (p === 'quick') void run(() => net.quickPlay(name, profileStore.get().appearance));
    else if (p === 'practice') void run(() => net.practice(name, profileStore.get().appearance));
    else if (p === 'create') setScreen('create');
    else if (p === 'browse') setScreen('browse');
    else setScreen('home');
  };

  const onHome = (a: HomeAction) => {
    if (a === 'settings') return setShowSettings(true);
    if (a === 'garage' || a === 'character') {
      setGarageTab(a === 'character' ? 'driver' : 'car');
      return setScreen('garage');
    }
    const p: Pending = a === 'practice' ? 'practice' : a === 'play' || a === 'quick' ? 'quick' : a === 'create' ? 'create' : 'browse';
    if (!profile.name) { setPending(p); setScreen('name'); return; }
    doPending(p, profile.name);
  };

  const leave = async () => {
    await net.leave();
    setResults(null);
    setScreen('home');
  };

  let content: JSX.Element;
  if (snap && myId) {
    if (garageInRoom) {
      content = (
        <Garage confirmLabel="Save to lobby" onDone={(app: Appearance) => { net.send(MSG.APPEARANCE, app); setGarageInRoom(false); }} />
      );
    } else if (results) {
      content = (
        <Results
          snap={results}
          myId={myId}
          onRematch={() => { net.send(MSG.REMATCH); setResults(null); }}
          onLobby={() => { if (net.offline) { void leave(); return; } net.send(MSG.TO_LOBBY); setResults(null); }}
          onLeave={leave}
        />
      );
    } else if (snap.phase === Phase.COUNTDOWN || snap.phase === Phase.RACING) {
      content = <Race onLeave={leave} />;
    } else {
      content = <Lobby snap={snap} myId={myId} onGarage={() => setGarageInRoom(true)} onLeave={leave} />;
    }
  } else if (screen === 'name') {
    content = (
      <NameEntry
        continueLabel={pending === 'practice' ? 'Start racing' : pending === 'create' ? 'Continue to room setup' : pending === 'browse' ? 'Continue to rooms' : 'Find a race'}
        onBack={() => setScreen('home')}
        onGarage={() => { setGarageTab('car'); setScreen('garage'); }}
        onContinue={(name) => doPending(pending, name)}
      />
    );
  } else if (screen === 'garage') {
    content = <Garage initialTab={garageTab} onDone={() => setScreen(profile.name || !pending ? 'home' : 'name')} />;
  } else if (screen === 'browse') {
    content = (
      <RoomBrowser
        busy={busy}
        onBack={() => setScreen('home')}
        onCreate={() => setScreen('create')}
        onJoin={(code) => void run(() => net.joinByCode(code, profile.name, profile.appearance))}
      />
    );
  } else if (screen === 'create') {
    content = (
      <CreateRoom
        busy={busy}
        defaultName={profile.name || 'Wobble'}
        onBack={() => setScreen('home')}
        onCreate={(o: CreateOpts) => void run(() => net.createRoom(profile.name, profile.appearance, o))}
      />
    );
  } else {
    content = <Home name={profile.name} busy={busy} onAction={onHome} />;
  }

  return (
    <>
      {content}
      {(status === 'connecting' || (status === 'reconnecting' && !inRace)) && (
        <div className="overlay">
          <div className="card stack" style={{ textAlign: 'center', minWidth: 260 }}>
            <div className="spinner" />
            <p>{status === 'connecting' ? 'Connecting to the race server…' : 'Connection lost. Reconnecting…'}</p>
            {status === 'reconnecting' && <Btn variant="ghost" style={{ color: 'var(--ink)' }} onClick={leave}>Give up</Btn>}
          </div>
        </div>
      )}
      {showSettings && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}>
          <div className="card modal"><SettingsPanel onClose={() => setShowSettings(false)} /></div>
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}
