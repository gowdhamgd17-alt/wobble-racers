import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Phase, RacerStatus } from '@wobble/shared';
import { Game, ordinal, webglAvailable, type HudData } from '../../game/Game';
import { haptic, input } from '../../input/Input';
import { net, useNet } from '../../net/Net';
import { settingsStore, useStore, type Action } from '../../state/store';
import { audio } from '../../audio/Audio';
import { Btn } from '../components/common';
import { SettingsPanel } from './SettingsPanel';

export function Race({ onLeave }: { onLeave: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [hud, setHud] = useState<HudData | null>(null);
  const [paused, setPaused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [fatal, setFatal] = useState(() => (webglAvailable() ? '' : 'Your browser or device does not support WebGL, which WOBBLE RACERS needs for 3D graphics.'));
  const [touchUI, setTouchUI] = useState(input.wantsTouchUI());
  const [portrait, setPortrait] = useState(false);
  const settings = useStore(settingsStore);
  const { status } = useNet();

  useEffect(() => {
    if (fatal || !hostRef.current) return;
    let g: Game;
    try {
      g = new Game(hostRef.current, setHud, setFatal);
    } catch (e) {
      setFatal(`Could not start 3D graphics: ${(e as Error).message}`);
      return;
    }
    gameRef.current = g;
    g.setMinimap(miniRef.current);
    g.start();
    audio.setMusic('race');
    return () => { g.dispose(); gameRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const upd = () => setTouchUI(input.wantsTouchUI());
    const off = input.onMethodChange(upd);
    const unsub = settingsStore.subscribe(upd);
    return () => { off(); unsub(); };
  }, []);

  useEffect(() => input.onPause(() => setPaused((p) => !p)), []);
  useEffect(() => { gameRef.current?.setPaused(paused || showSettings); }, [paused, showSettings]);

  // Portrait phones: pause input and ask to rotate.
  useEffect(() => {
    const check = () => {
      const p = touchUI && window.innerHeight > window.innerWidth * 1.05;
      setPortrait(p);
      if (gameRef.current) gameRef.current.blocked = p;
      input.resetAll();
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => { window.removeEventListener('resize', check); window.removeEventListener('orientationchange', check); };
  }, [touchUI]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
      } else {
        await document.exitFullscreen();
      }
    } catch {
      /* not supported (e.g. iPhone Safari) */
    }
  };

  if (fatal) {
    return (
      <div className="menu-bg">
        <div className="center-msg">
          <div className="card" style={{ maxWidth: 480 }}>
            <h3>Graphics problem</h3>
            <p>{fatal}</p>
            <div className="row end" style={{ marginTop: 16 }}><Btn variant="danger" onClick={onLeave}>Leave race</Btn></div>
          </div>
        </div>
      </div>
    );
  }

  const h = hud;
  const finished = h?.status === RacerStatus.FINISHED;
  return (
    <div className={`race-root ${touchUI ? 'touch-mode' : ''}`} ref={hostRef} onContextMenu={(e) => e.preventDefault()}>
      <div className="hud" style={{ ['--touch-scale' as string]: settings.touchScale }}>
        {h && h.hitFlash > 0 && <div className="hit-flash" style={{ opacity: h.hitFlash }} />}
        <div className="hud-tl">
          <div className="hud-panel">
            <div className="pos-big">{h?.rank || '-'}<small>/{h?.total ?? '-'}</small></div>
            <div className="lap-text">{finished ? 'Finished!' : `Lap ${h?.lap ?? 1}/${h?.laps ?? '-'}`}</div>
          </div>
          <div className="hud-panel leader">
            {h?.leaderboard.slice(0, 6).map((r) => (
              <div key={r.id} className={`lrow ${r.me ? 'me' : ''} ${r.status === RacerStatus.LEFT ? 'gone' : ''}`}>
                <span style={{ width: 18, textAlign: 'right' }}>{r.rank}</span>
                <span className="dot" style={{ background: r.color, width: 10, height: 10 }} />
                <span className="lname">{r.name}</span>
                {r.status === RacerStatus.FINISHED && <span>🏁</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="hud-tr">
          <canvas ref={miniRef} className="minimap" aria-label="Track map" />
          <div className="stack" style={{ gap: 6 }}>
            <button className="hud-btn" aria-label="Pause" onClick={() => setPaused(true)}>❚❚</button>
            {!touchUI && <button className="hud-btn" aria-label="Recover car" title="Recover (R)" onPointerDown={() => input.pointerDown(-99, 'recover')} onPointerUp={() => input.pointerUp(-99)} onPointerLeave={() => input.pointerUp(-99)}>⟲</button>}
          </div>
        </div>
        <div className="hud-bl hud-panel">
          <div className="meter"><span>HP</span><div className="track"><div className={`fill hp-${h?.damage ?? 'healthy'}`} style={{ width: `${h?.health ?? 100}%` }} /></div></div>
          {h?.nitroOn !== false && <div className="meter"><span>N₂O</span><div className="track"><div className={`fill nitro ${h?.boosting ? 'on' : ''}`} style={{ width: `${h?.nitro ?? 0}%` }} /></div></div>}
          {h?.weaponsOn !== false && <div className="meter"><span>Gun</span><div className="track"><div className="fill weapon" style={{ width: `${(h?.fireReady ?? 1) * 100}%` }} /></div></div>}
        </div>
        <div className="hud-br">
          <div className="speed">{h?.speedKmh ?? 0}<small> km/h</small></div>
        </div>

        {h?.phase === Phase.COUNTDOWN && <div className="center-banner" key={Math.ceil(h.countdown)}>{Math.ceil(h.countdown) || 'GO!'}</div>}
        {h?.banner && <div className="center-banner" key={h.banner}>{h.banner}</div>}
        {h?.status === RacerStatus.DESTROYED && <div className="center-banner sub">Respawning in {h.respawnT.toFixed(1)}s…</div>}
        {h?.wrongWay && <div className="wrong-way">WRONG WAY</div>}
        {finished && !h?.banner && (
          <div className="center-banner sub interactive" style={{ pointerEvents: 'auto' }}>
            <div>You finished {ordinal(h!.finishPlace)}! {h?.spectating ? `Watching ${h.spectating}` : 'Waiting for the others…'}</div>
            <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
              <Btn variant="sky" onClick={() => gameRef.current?.spectateNext()}>{h?.spectating ? 'Next racer' : 'Watch racers'}</Btn>
              {h?.spectating && <Btn onClick={() => gameRef.current?.stopSpectating()}>My car</Btn>}
            </div>
          </div>
        )}
        {status === 'reconnecting' && <div className="reconnect-bar"><div className="spinner" /> Connection lost, reconnecting…</div>}
        {settings.showFps && <div className="fps">{h?.fps ?? 0} fps</div>}
      </div>

      {touchUI && !paused && <TouchControls disabledFire={h?.weaponsOn === false} disabledNitro={h?.nitroOn === false} />}

      {portrait && (
        <div className="rotate-overlay">
          <div>
            <div className="phone" />
            <h2>Rotate your device</h2>
            <p className="muted">WOBBLE RACERS plays in landscape. Your car is coasting safely meanwhile.</p>
          </div>
        </div>
      )}

      {(paused || showSettings) && !portrait && (
        <div className="overlay">
          {showSettings ? (
            <div className="card modal">
              <SettingsPanel onClose={() => setShowSettings(false)} />
            </div>
          ) : confirmLeave ? (
            <div className="card modal stack">
              <h3>Leave the race?</h3>
              <p>You will be listed as "left" in the results. The race continues for everyone else.</p>
              <div className="row end">
                <Btn onClick={() => setConfirmLeave(false)}>Stay</Btn>
                <Btn variant="danger" onClick={onLeave}>Leave race</Btn>
              </div>
            </div>
          ) : (
            <div className="card modal pause-list">
              <h3>Paused</h3>
              <p className="small muted">The race keeps going for everyone else! Your car coasts while you're paused.</p>
              <Btn variant="primary big" onClick={() => setPaused(false)}>Resume</Btn>
              <Btn onClick={() => setShowSettings(true)}>Settings & controls</Btn>
              <Btn onClick={toggleFullscreen}>Toggle fullscreen</Btn>
              <Btn variant="danger" onClick={() => setConfirmLeave(true)}>Leave race</Btn>
            </div>
          )}
        </div>
      )}
      {!h && <div className="overlay"><div className="spinner" /></div>}
      <span hidden>{net.myId}</span>
    </div>
  );
}

const ICONS: Record<string, JSX.Element> = {
  left: <svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  right: <svg viewBox="0 0 24 24"><path d="m9 4 8 8-8 8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

function TouchControls({ disabledFire, disabledNitro }: { disabledFire: boolean; disabledNitro: boolean }) {
  const [down, setDown] = useState<Set<Action>>(new Set());
  const steerPad = useRef<HTMLDivElement>(null);
  const refresh = () => {
    const s = new Set<Action>();
    for (const a of ['left', 'right', 'accelerate', 'brake', 'drift', 'nitro', 'fire', 'recover'] as Action[]) if (input.isDown(a)) s.add(a);
    setDown(s);
  };
  useEffect(() => () => input.resetAll(), []);

  const steerAction = (e: RPointerEvent) => {
    const r = steerPad.current!.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? 'left' : 'right';
  };
  const release = (e: RPointerEvent) => { input.pointerUp(e.pointerId); refresh(); };
  const btn = (a: Action, label: string, cls = '', disabled = false) => (
    <div
      className={`tbtn ${cls} ${down.has(a) ? 'down' : ''} ${disabled ? 'disabled' : ''}`}
      role="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        input.pointerDown(e.pointerId, a);
        if (a === 'fire' || a === 'nitro') haptic(10);
        refresh();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    >
      {label}
    </div>
  );
  return (
    <div className="touch">
      <div
        ref={steerPad}
        className="pad left-pad"
        onPointerDown={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          input.pointerDown(e.pointerId, steerAction(e));
          refresh();
        }}
        onPointerMove={(e) => {
          // slide a thumb between left and right without lifting it
          input.pointerMove(e.pointerId, steerAction(e));
          refresh();
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <div className={`tbtn steer ${down.has('left') ? 'down' : ''}`} aria-label="Steer left">{ICONS.left}</div>
        <div className={`tbtn steer ${down.has('right') ? 'down' : ''}`} aria-label="Steer right">{ICONS.right}</div>
      </div>
      <div className="pad right-pad">
        {btn('nitro', 'NITRO', 'small', disabledNitro)}
        {btn('fire', 'FIRE', '', disabledFire)}
        {btn('accelerate', 'GAS', 'gas')}
        {btn('drift', 'DRIFT', 'small')}
        {btn('brake', 'BRAKE')}
      </div>
      <div className="top-right-actions">{btn('recover', '⟲', 'small')}</div>
    </div>
  );
}
