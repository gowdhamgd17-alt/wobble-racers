import { useState } from 'react';
import { MIN_PLAYERS_TO_START, MSG, Phase, VEHICLES, characterInfo, colorHex, type RaceSettings } from '@wobble/shared';
import type { RoomSnap } from '../../net/Net';
import { net } from '../../net/Net';
import { Btn, Thumb, useToast } from '../components/common';
import { SettingsFields } from './Rooms';

export function Lobby({ snap, myId, onGarage, onLeave }: { snap: RoomSnap; myId: string; onGarage: () => void; onLeave: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const me = snap.players.find((p) => p.id === myId);
  const isHost = snap.hostId === myId;
  const connected = snap.players.filter((p) => p.connected);
  const notReady = connected.filter((p) => p.id !== snap.hostId && !p.ready);
  let blocker = '';
  if (connected.length < MIN_PLAYERS_TO_START) blocker = 'Waiting for at least one more player to join…';
  else if (notReady.length) blocker = `Waiting for ${notReady.map((p) => p.name).join(', ')} to get ready`;
  const empty = Math.max(0, snap.maxPlayers - snap.players.length);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snap.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast(`Room code: ${snap.code}`);
    }
  };
  const changeSettings = (p: Partial<RaceSettings>) => net.send(MSG.SETTINGS, p);

  return (
    <div className="menu-bg">
      <div className="screen">
        <div className="topbar">
          <h2 title={snap.roomName}>{snap.roomName}</h2>
          <button className="code-chip" onClick={copy} title="Copy room code" aria-label={`Room code ${snap.code}, tap to copy`}>{copied ? 'COPIED' : snap.code}</button>
          <span className="count-chip">{connected.length}/{snap.maxPlayers} players{snap.isPrivate ? ' · private' : ''}</span>
        </div>
        <div className="split" style={{ gridTemplateColumns: '1.6fr 1fr' }}>
          <div className="stack">
            <div className="slots">
              {snap.players.map((p) => (
                <div key={p.id} className={`slot ${p.id === myId ? 'me' : ''} ${p.connected ? '' : 'away'}`}>
                  <Thumb appearance={p} alt={`${p.name}'s car`} />
                  <div style={{ minWidth: 0 }}>
                    <div className="name">{p.name} <span className="small muted">{p.tag}</span></div>
                    <div className="meta">
                      <span className="dot" style={{ background: colorHex(p.colorMain) }} />
                      {VEHICLES[p.carClass as 'drifter']?.label} · {characterInfo(p.character).name}
                    </div>
                    <div className="meta" style={{ marginTop: 4 }}>
                      {p.isHost && <span className="badge host">Host</span>}
                      {!p.connected ? <span className="badge notready">Reconnecting…</span> : p.isHost ? null : p.ready ? <span className="badge ready">Ready</span> : <span className="badge notready">Not ready</span>}
                    </div>
                  </div>
                </div>
              ))}
              {Array.from({ length: Math.min(empty, 15) }, (_, i) => (
                <div key={`e${i}`} className="slot empty">Open slot</div>
              ))}
            </div>
          </div>
          <div className="card stack">
            <div className="row between">
              <h3 style={{ margin: 0 }}>Race settings</h3>
              {!isHost && <span className="small muted">Host decides</span>}
            </div>
            <SettingsFields s={snap.settings} onChange={changeSettings} disabled={!isHost} />
          </div>
        </div>
        <div className="lobby-actions">
          <p className="hint">
            {snap.phase === Phase.WAITING_FOR_PLAYERS
              ? `Share code ${snap.code} with a friend. The race can start as soon as 2 players are here.`
              : isHost ? (blocker || 'Everyone is ready. Start the race!') : me?.ready ? 'Ready! Waiting for the host to start.' : 'Tap Ready when you are set.'}
          </p>
          <Btn variant="ghost" onClick={onLeave}>Leave</Btn>
          <Btn onClick={onGarage}>Garage</Btn>
          <Btn variant="sky" onClick={() => net.send(MSG.EMOTE)}>Honk</Btn>
          {!isHost && (
            <Btn variant={me?.ready ? 'go' : 'primary'} onClick={() => net.send(MSG.READY, { ready: !me?.ready })}>
              {me?.ready ? 'Ready ✓' : 'Ready'}
            </Btn>
          )}
          {isHost && (
            <Btn variant="go" disabled={!!blocker} onClick={() => net.send(MSG.START)} title={blocker}>
              Start race
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}
