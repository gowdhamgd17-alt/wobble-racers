import { useEffect, useState } from 'react';
import { Btn } from '../components/common';
import { SERVER_MISSING_MSG, checkServer } from '../../net/Net';

export type HomeAction = 'practice' | 'battle' | 'play' | 'quick' | 'create' | 'browse' | 'garage' | 'character' | 'settings';

export function Home({ name, onAction, busy }: { name: string; onAction: (a: HomeAction) => void; busy: boolean }) {
  const title = 'WOBBLE RACERS';
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const run = () => checkServer().then((ok) => { if (alive) setServerOk(ok); });
    void run();
    const id = setInterval(run, 15000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <div className="menu-bg">
      <div className="screen" style={{ maxWidth: 720, paddingTop: 'clamp(12px, 6vh, 64px)' }}>
        <div>
          <h1 className="logo" aria-label={title}>
            {title.split(' ').map((w, wi) => (
              <div key={wi}>{[...w].map((ch, i) => <span key={i}>{ch}</span>)}</div>
            ))}
          </h1>
          <p className="tagline">Race, drift, boost and blast your friends off the road, or fight it out in the Battleground. 2 to 15 players.</p>
        </div>
        {serverOk === false && (
          <div className="card server-banner" role="alert">
            <h3>Online multiplayer is offline</h3>
            <p className="small">You can still race right now against 7 bots. {SERVER_MISSING_MSG()}</p>
          </div>
        )}
        <div className="home-grid">
          {serverOk === false ? (
            <Btn variant="primary big wide" disabled={busy} onClick={() => onAction('practice')}>
              Play now vs bots
            </Btn>
          ) : (
            <Btn variant="primary big wide" disabled={busy} onClick={() => onAction('play')}>
              {name ? `Play now as ${name}` : 'Play now'}
            </Btn>
          )}
          {serverOk !== false && <Btn variant="ghost wide" disabled={busy} onClick={() => onAction('practice')}>Practice vs bots (offline)</Btn>}
          <Btn variant="danger wide" disabled={busy} onClick={() => onAction('battle')}>💥 Battleground vs bots</Btn>
          <Btn variant="go" disabled={busy} onClick={() => onAction('quick')}>Quick Play</Btn>
          <Btn variant="sky" disabled={busy} onClick={() => onAction('create')}>Create Room</Btn>
          <Btn disabled={busy} onClick={() => onAction('browse')}>Join Room</Btn>
          <Btn variant="ghost" onClick={() => onAction('garage')}>Garage</Btn>
          <Btn variant="ghost" onClick={() => onAction('character')}>Characters</Btn>
          <Btn variant="ghost" onClick={() => onAction('settings')}>Settings</Btn>
        </div>
        <p className="muted small" style={{ textAlign: 'center' }}>
          Desktop: <span className="kbd">W A S D</span> drive · <span className="kbd">Space</span> drift · <span className="kbd">Shift</span> nitro · <span className="kbd">F</span> fire · <span className="kbd">R</span> reload · <span className="kbd">1</span>–<span className="kbd">0</span> / <span className="kbd">Q</span> <span className="kbd">E</span> switch gun. Phones & tablets get touch controls.
        </p>
      </div>
    </div>
  );
}
