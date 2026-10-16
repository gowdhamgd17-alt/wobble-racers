import { useEffect, useRef, useState } from 'react';
import { Phase, RacerStatus, WEAPONS } from '@wobble/shared';
import { Game, ordinal, webglAvailable, type HudData } from '../../game/Game';
import { haptic, input } from '../../input/Input';
import { net, useNet } from '../../net/Net';
import { settingsStore, useStore, type Action } from '../../state/store';
import { audio } from '../../audio/Audio';
import { Btn } from '../components/common';
import { SettingsPanel } from './SettingsPanel';
import { VoiceHud } from '../components/Voice';
import { TouchControls } from '../components/TouchControls';

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
  const [editingControls, setEditingControls] = useState(false);
  const [isFull, setIsFull] = useState(!!document.fullscreenElement);
  useEffect(() => {
    const on = () => setIsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
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
  useEffect(() => { gameRef.current?.setPaused(paused || showSettings || editingControls); }, [paused, showSettings, editingControls]);

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

  const canFullscreen = !!document.documentElement.requestFullscreen;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.matchMedia?.('(display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  // Phones: go full screen on the first tap of the race (browsers need a tap to allow it).
  const autoFull = () => {
    if (touchUI && settings.autoFullscreen && canFullscreen && !document.fullscreenElement && !standalone) void toggleFullscreen();
  };
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
  const battle = !!h?.battle;
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const hpPct = h ? Math.max(0, Math.min(100, (h.health / Math.max(1, h.maxHealth)) * 100)) : 100;
  return (
    <div className={`race-root ${touchUI ? 'touch-mode' : ''}`} ref={hostRef} onContextMenu={(e) => e.preventDefault()} onPointerDownCapture={autoFull}>
      <div className="hud" style={{ ['--touch-scale' as string]: settings.touchScale }}>
        {h && h.hitFlash > 0 && <div className="hit-flash" style={{ opacity: h.hitFlash }} />}
        <div className="hud-tl">
          {battle ? (
            <div className="hud-panel">
              <div className="pos-big">{h?.kills ?? 0}<small>/{h?.killTarget} kills</small></div>
              <div className="lap-text">
                #{h?.rank || '-'} of {h?.total ?? '-'}{h?.timeLimited ? ` · ${mmss(h.timeLeft)}` : ''}
              </div>
            </div>
          ) : (
          <div className="hud-panel">
            <div className="pos-big">{h?.rank || '-'}<small>/{h?.total ?? '-'}</small></div>
            <div className="lap-text">
              {finished ? 'Finished!' : h?.sprint ? `${(h.coveredKm ?? 0).toFixed(1)} / ${h.raceKm.toFixed(1)} km` : `Lap ${h?.lap ?? 1}/${h?.laps ?? '-'}`}
            </div>
            {h?.sprint && !finished && (
              <div className="meter" style={{ marginTop: 4 }}><span>🏁</span><div className="track"><div className="fill nitro" style={{ width: `${Math.min(100, ((h.coveredKm ?? 0) / Math.max(0.1, h.raceKm)) * 100)}%` }} /></div></div>
            )}
          </div>
          )}
          <div className="hud-panel leader">
            {h?.leaderboard.slice(0, 6).map((r) => (
              <div key={r.id} className={`lrow ${r.me ? 'me' : ''} ${r.status === RacerStatus.LEFT ? 'gone' : ''}`}>
                <span style={{ width: 18, textAlign: 'right' }}>{r.rank}</span>
                <span className="dot" style={{ background: r.color, width: 10, height: 10 }} />
                <span className="lname">{r.name}</span>
                {battle ? <span className="kd">{r.kills}</span> : r.status === RacerStatus.FINISHED && <span>🏁</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="hud-tr">
          <canvas ref={miniRef} className="minimap" aria-label="Track map" />
          <div className="stack" style={{ gap: 6 }}>
            <button className="hud-btn" aria-label="Pause" onClick={() => setPaused(true)}>❚❚</button>
            <VoiceHud names={new Map((h?.leaderboard ?? []).map((r) => [r.id, r.me ? 'You' : r.name]))} />
            <button className="hud-btn" aria-label="Recover car" title="Recover (R)" onPointerDown={() => input.pointerDown(-99, 'recover')} onPointerUp={() => input.pointerUp(-99)} onPointerLeave={() => input.pointerUp(-99)}>⟲</button>
            {touchUI && canFullscreen && !standalone && <button className="hud-btn" aria-label={isFull ? 'Exit full screen' : 'Full screen'} onClick={() => void toggleFullscreen()}>{isFull ? '⤡' : '⛶'}</button>}
          </div>
        </div>
        <div className="hud-bl hud-panel">
          <div className="meter"><span>HP</span><div className="track"><div className={`fill hp-${h?.damage ?? 'healthy'}`} style={{ width: `${hpPct}%` }} /></div></div>
          {h?.nitroOn !== false && <div className="meter"><span>N₂O</span><div className="track"><div className={`fill nitro ${h?.boosting ? 'on' : ''}`} style={{ width: `${h?.nitro ?? 0}%` }} /></div></div>}
          {h?.weaponsOn !== false && h && (
            <div className={`weapon-row ${h.ownWeapon ? '' : 'crate'}`}>
              <span className="wname">{h.weaponName}</span>
              {h.reloading > 0 ? (
                <span className="ammo reloading">
                  <span className="rbar"><span style={{ width: `${h.reloading * 100}%` }} /></span>RELOAD
                </span>
              ) : (
                <span className={`ammo ${h.ammo <= Math.ceil(h.magazine * 0.2) ? 'low' : ''}`}>{h.ammo}<small>/{h.magazine}</small></span>
              )}
            </div>
          )}
          {h?.weaponsOn !== false && h && (
            <div className="gun-bar" role="toolbar" aria-label="Choose gun">
              {WEAPONS.map((w, i) => (
                <button key={w.id} className={i === h.weaponIndex ? 'on' : ''} title={`${w.label} (key ${i === 9 ? 0 : i + 1})`} aria-label={w.label} aria-pressed={i === h.weaponIndex}
                  onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); gameRef.current?.selectWeapon(i); }}>
                  <span className="gk">{i === 9 ? 0 : i + 1}</span>{GUN_SHORT[w.id]}
                </button>
              ))}
            </div>
          )}
          {h && h.powerT > 0 && <div className="power-badge">⚡ ×1.5 DAMAGE · {Math.ceil(h.powerT)}s</div>}
        </div>
        {h && h.killFeed.length > 0 && (
          <div className="killfeed">
            {h.killFeed.map((k) => (
              <div key={k.id} className={`kf ${k.meKiller ? 'mine' : ''} ${k.meVictim ? 'dead' : ''}`}>
                {k.killer ? <b style={{ color: k.killerColor }}>{k.killer}</b> : null}
                <span className="kw">{weaponLabel(k.weapon)}</span>
                <b style={{ color: k.victimColor }}>{k.victim}</b>
              </div>
            ))}
          </div>
        )}
        {h?.saavu && (
          <div className="saavu" key={h.saavu.key}>
            <div className="saavu-title">{h.saavu.title}</div>
            <div className="saavu-sub">{h.saavu.sub}</div>
          </div>
        )}
        <div className="hud-br">
          <div className="speed">{h?.speedKmh ?? 0}<small> km/h</small></div>
        </div>

        {h?.phase === Phase.COUNTDOWN && <div className="center-banner" key={Math.ceil(h.countdown)}>{Math.ceil(h.countdown) || 'GO!'}</div>}
        {h?.banner && <div className="center-banner" key={h.banner}>{h.banner}</div>}
        {h?.status === RacerStatus.DESTROYED && (
          <div className="center-banner sub">
            {h.killedBy ? <div className="killed-by">Destroyed by {h.killedBy}</div> : <div className="killed-by">Wrecked!</div>}
            New car in {h.respawnT.toFixed(1)}s…
          </div>
        )}
        {h?.wrongWay && <div className="wrong-way">WRONG WAY</div>}
        {finished && !h?.banner && !battle && (
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

      {touchUI && (!paused || editingControls) && (
        <TouchControls weaponsOn={h?.weaponsOn !== false} nitroOn={h?.nitroOn !== false} editing={editingControls} onDoneEditing={() => { setEditingControls(false); setPaused(false); }} />
      )}

      {portrait && (
        <div className="rotate-overlay">
          <div>
            <div className="phone" />
            <h2>Rotate your device</h2>
            <p className="muted">WOBBLE RACERS plays in landscape. Your car is coasting safely meanwhile.</p>
          </div>
        </div>
      )}

      {(paused || showSettings) && !portrait && !editingControls && (
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
              {touchUI && <Btn onClick={() => setEditingControls(true)}>Customize on-screen controls</Btn>}
              {canFullscreen && !standalone && <Btn onClick={toggleFullscreen}>{isFull ? 'Exit full screen' : 'Full screen'}</Btn>}
              {isIOS && !standalone && <p className="small muted">iPhone tip: tap Share ⬆ then "Add to Home Screen" to play full screen like an app.</p>}
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

const GUN_SHORT: Record<string, string> = {
  pistol: 'PST', smg: 'SMG', m4: 'M4', shotgun: 'SHT', minigun: 'MIN', sniper: 'SNP', rocket: 'RKT', grenade: 'GRN', flamer: 'FLM', homing: 'HOM',
};

function weaponLabel(id: string) {
  const names: Record<string, string> = { ram: 'rammed', wall: 'crashed', fall: 'fell', test: 'zapped' };
  if (names[id]) return names[id];
  return WEAPONS.find((w) => w.id === id)?.label ?? id;
}
