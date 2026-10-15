import { useCallback, useEffect, useState } from 'react';
import { ARENA_DEFS, DEFAULT_SETTINGS, KILL_TARGETS, KM_OPTIONS, LAP_OPTIONS, TIME_LIMITS, MAX_PLAYERS, Phase, ROOM_NAME_MAX_LENGTH, TRACK_DEFS, sanitizeSettings, tracksFor, type Layout, type RaceSettings } from '@wobble/shared';
import { net, type RoomListing } from '../../net/Net';
import { Btn, Segmented, Toggle } from '../components/common';

const PHASE_LABEL: Record<string, string> = {
  [Phase.WAITING_FOR_PLAYERS]: 'Waiting for players',
  [Phase.LOBBY]: 'In lobby',
  [Phase.COUNTDOWN]: 'Starting',
  [Phase.RACING]: 'Racing',
  [Phase.RESULTS]: 'Results',
};

export function RoomBrowser({ onBack, onJoin, onCreate, busy }: { onBack: () => void; onJoin: (code: string) => void; onCreate: () => void; busy: boolean }) {
  const [rooms, setRooms] = useState<RoomListing[] | null>(null);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const refresh = useCallback(async () => {
    try {
      setRooms(await net.listRooms());
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="menu-bg">
      <div className="screen">
        <div className="topbar">
          <Btn variant="ghost icon" aria-label="Back" onClick={onBack}>←</Btn>
          <h2>Join a room</h2>
          <Btn variant="sky" onClick={onCreate}>Create Room</Btn>
        </div>
        <form className="card row" onSubmit={(e) => { e.preventDefault(); onJoin(code); }}>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="code">Have a code? (private rooms too)</label>
            <input id="code" className="input code" value={code} maxLength={8} placeholder="ABCDE" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </div>
          <Btn type="submit" variant="primary" disabled={busy || code.trim().length < 4} style={{ alignSelf: 'flex-end' }}>Join</Btn>
        </form>
        <div className="card stack">
          <div className="row between">
            <h3 style={{ margin: 0 }}>Public rooms</h3>
            <Btn className="icon" aria-label="Refresh" onClick={refresh}>↻</Btn>
          </div>
          {err && <p className="error-text">{err}</p>}
          {!rooms && !err && <div className="spinner" />}
          {rooms && rooms.length === 0 && <p className="muted">No public rooms right now. Create one or hit Quick Play!</p>}
          <div className="room-list">
            {rooms?.map((r) => {
              const phase = r.metadata.phase ?? '';
              const players = r.metadata.players ?? r.clients;
              const max = r.metadata.maxPlayers ?? r.maxClients ?? MAX_PLAYERS;
              const joinable = !r.locked && (phase === Phase.LOBBY || phase === Phase.WAITING_FOR_PLAYERS) && players < max;
              return (
                <div key={r.code} className="room-item">
                  <div>
                    <div className="title">{r.metadata.name ?? r.code}</div>
                    <div className="small muted">{r.metadata.track}{r.metadata.mode === 'battle' ? '' : ` · ${r.metadata.laps} laps`} · code {r.code}</div>
                  </div>
                  <div className="phase small">{PHASE_LABEL[phase] ?? phase}</div>
                  <Btn variant={joinable ? 'go' : ''} disabled={!joinable || busy} onClick={() => onJoin(r.code)}>
                    {players}/{max} {joinable ? 'Join' : players >= max ? 'Full' : 'Busy'}
                  </Btn>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface CreateOpts { roomName: string; private: boolean; maxPlayers: number; settings: RaceSettings }

export function CreateRoom({ defaultName, onBack, onCreate, busy }: { defaultName: string; onBack: () => void; onCreate: (o: CreateOpts) => void; busy: boolean }) {
  const [roomName, setRoomName] = useState(`${defaultName}'s Room`.slice(0, ROOM_NAME_MAX_LENGTH));
  const [priv, setPriv] = useState(false);
  const [maxPlayers, setMax] = useState(MAX_PLAYERS);
  const [s, setS] = useState<RaceSettings>(DEFAULT_SETTINGS);
  return (
    <div className="menu-bg">
      <div className="screen" style={{ maxWidth: 720 }}>
        <div className="topbar">
          <Btn variant="ghost icon" aria-label="Back" onClick={onBack}>←</Btn>
          <h2>Create a room</h2>
        </div>
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); onCreate({ roomName, private: priv, maxPlayers, settings: s }); }}>
          <div className="field">
            <label htmlFor="rname">Room name</label>
            <input id="rname" className="input" value={roomName} maxLength={ROOM_NAME_MAX_LENGTH} onChange={(e) => setRoomName(e.target.value)} />
          </div>
          <Toggle label={priv ? 'Private (join by code only)' : 'Public (listed in the room browser)'} checked={priv} onChange={setPriv} />
          <div className="field">
            <label>Max players: {maxPlayers} <span className="muted small">(races can start with 2)</span></label>
            <input className="range" type="range" min={2} max={MAX_PLAYERS} value={maxPlayers} onChange={(e) => setMax(Number(e.target.value))} />
          </div>
          <SettingsFields s={s} onChange={(p) => setS(sanitizeSettings(p, s))} />
          <Btn type="submit" variant="primary big" disabled={busy}>Create room</Btn>
        </form>
      </div>
    </div>
  );
}

export function SettingsFields({ s, onChange, disabled }: { s: RaceSettings; onChange: (p: Partial<RaceSettings>) => void; disabled?: boolean }) {
  const layout = (s.layout === 'straight' ? 'straight' : 'loop') as Layout;
  const options = tracksFor(layout);
  const def = TRACK_DEFS.find((t) => t.id === s.trackId);
  const total = layout === 'loop' ? s.distanceKm * s.laps : s.distanceKm;
  const battle = s.mode === 'battle';
  const modeField = (
    <div className="field">
      <label>Game mode</label>
      <Segmented<string>
        options={['race', 'battle']}
        value={battle ? 'battle' : 'race'}
        disabled={disabled}
        onChange={(v) => onChange({ mode: v, ...(v === 'battle' ? { weapons: true, damage: true } : {}) })}
        render={(v) => (v === 'race' ? '🏁 Race' : '💥 Battleground')}
      />
    </div>
  );
  const toggles = (
    <div>
      <Toggle label="Car collisions" checked={s.collisions} disabled={disabled} onChange={(v) => onChange({ collisions: v })} />
      <Toggle label="Car damage & destruction" checked={s.damage} disabled={disabled} onChange={(v) => onChange({ damage: v })} />
      <Toggle label="Weapons, crates & repair kits" checked={s.weapons} disabled={disabled} onChange={(v) => onChange({ weapons: v })} />
      <Toggle label="Nitro & boost pads" checked={s.nitro} disabled={disabled} onChange={(v) => onChange({ nitro: v })} />
      <Toggle label={<>Drifting <span className="small muted">(off: handbrake just brakes)</span></>} checked={s.drift} disabled={disabled} onChange={(v) => onChange({ drift: v })} />
    </div>
  );
  if (battle) {
    const arena = ARENA_DEFS.find((a) => a.id === s.arenaId) ?? ARENA_DEFS[0];
    return (
      <div className="stack">
        {modeField}
        <div className="field">
          <label>Map</label>
          <Segmented options={ARENA_DEFS.map((a) => a.id)} value={arena.id} disabled={disabled} onChange={(v) => onChange({ arenaId: v })} render={(v) => ARENA_DEFS.find((a) => a.id === v)!.name} />
          <span className="small muted">{arena.description} Everyone fights in the same town; repair kits and weapon crates keep coming back.</span>
        </div>
        <div className="field">
          <label>Kills to win</label>
          <Segmented options={KILL_TARGETS} value={s.killTarget as (typeof KILL_TARGETS)[number]} disabled={disabled} onChange={(v) => onChange({ killTarget: v })} />
        </div>
        <div className="field">
          <label>Time limit</label>
          <Segmented options={TIME_LIMITS} value={s.timeLimit as (typeof TIME_LIMITS)[number]} disabled={disabled} onChange={(v) => onChange({ timeLimit: v })} render={(v) => (v ? `${v} min` : 'None')} />
        </div>
        {toggles}
      </div>
    );
  }
  return (
    <div className="stack">
      {modeField}
      <div className="field">
        <label>Course type</label>
        <Segmented<Layout>
          options={['loop', 'straight']}
          value={layout}
          disabled={disabled}
          onChange={(v) => onChange({ layout: v, trackId: tracksFor(v)[0].id })}
          render={(v) => (v === 'loop' ? 'Loop circuit (laps)' : 'Straight sprint (A to B)')}
        />
      </div>
      <div className="field">
        <label>Track</label>
        <Segmented options={options.map((t) => t.id)} value={s.trackId} disabled={disabled} onChange={(v) => onChange({ trackId: v })} render={(v) => TRACK_DEFS.find((t) => t.id === v)!.name} />
        {def && <span className="small muted">{def.description}</span>}
      </div>
      <div className="field">
        <label>{layout === 'loop' ? 'Lap length' : 'Sprint distance'}</label>
        <Segmented options={KM_OPTIONS} value={s.distanceKm as (typeof KM_OPTIONS)[number]} disabled={disabled} onChange={(v) => onChange({ distanceKm: v })} render={(v) => `${v} km`} />
      </div>
      {layout === 'loop' && (
        <div className="field">
          <label>Laps</label>
          <Segmented options={LAP_OPTIONS} value={s.laps} disabled={disabled} onChange={(v) => onChange({ laps: v })} />
        </div>
      )}
      <p className="small muted" style={{ color: 'inherit', opacity: 0.75 }}>
        Race distance: <strong>{total % 1 ? total.toFixed(1) : total} km</strong>
        {layout === 'loop' ? ` (${s.laps} × ${s.distanceKm} km)` : ' from start gate to finish gate'}
      </p>
      {toggles}
    </div>
  );
}

const PRACTICE_KEY = 'wobble.practice';
export interface PracticeOpts { settings: RaceSettings; bots: number }

export function PracticeSetup({ onBack, onStart, busy, mode = 'race' }: { onBack: () => void; onStart: (o: PracticeOpts) => void; busy: boolean; mode?: string }) {
  const [opts, setOpts] = useState<PracticeOpts>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PRACTICE_KEY) ?? 'null');
      if (raw) return { settings: sanitizeSettings({ ...raw.settings, mode }, { ...DEFAULT_SETTINGS, laps: 2 }), bots: Math.max(1, Math.min(14, Number(raw.bots) || 7)) };
    } catch { /* ignore */ }
    return { settings: { ...DEFAULT_SETTINGS, laps: 2, mode }, bots: 7 };
  });
  const battle = opts.settings.mode === 'battle';
  const start = () => {
    try { localStorage.setItem(PRACTICE_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
    onStart(opts);
  };
  return (
    <div className="menu-bg">
      <div className="screen" style={{ maxWidth: 720 }}>
        <div className="topbar">
          <Btn variant="ghost icon" aria-label="Back" onClick={onBack}>←</Btn>
          <h2>{battle ? 'Battleground vs bots' : 'Race vs bots'}</h2>
        </div>
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <div className="field">
            <label>Bots: {opts.bots}</label>
            <input className="range" type="range" min={1} max={14} value={opts.bots} onChange={(e) => setOpts({ ...opts, bots: Number(e.target.value) })} />
          </div>
          <SettingsFields s={opts.settings} onChange={(p) => setOpts({ ...opts, settings: sanitizeSettings(p, opts.settings) })} />
          <Btn type="submit" variant="primary big" disabled={busy}>{battle ? 'Start battle' : 'Start race'}</Btn>
        </form>
      </div>
    </div>
  );
}
