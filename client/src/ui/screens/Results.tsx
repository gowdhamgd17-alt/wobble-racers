import { RacerStatus, VEHICLES, characterInfo } from '@wobble/shared';
import type { RoomSnap } from '../../net/Net';
import { ordinal } from '../../game/Game';
import { net } from '../../net/Net';
import { Btn, Thumb } from '../components/common';

export function Results({ snap, myId, onRematch, onLobby, onLeave }: { snap: RoomSnap; myId: string; onRematch: () => void; onLobby: () => void; onLeave: () => void }) {
  // Finishers by finish order, then unfinished racers by progress rank, then players who left.
  const rows = [...snap.players].sort((a, b) => {
    const ka = a.finishPlace || (a.status === RacerStatus.LEFT ? 900 : 100) + a.rank;
    const kb = b.finishPlace || (b.status === RacerStatus.LEFT ? 900 : 100) + b.rank;
    return ka - kb;
  });
  const me = snap.players.find((p) => p.id === myId);
  const winner = rows[0];
  return (
    <div className="menu-bg">
      <div className="screen" style={{ maxWidth: 820 }}>
        <div style={{ textAlign: 'center' }}>
          <h1 className="logo" style={{ fontSize: 'clamp(40px, 9vw, 80px)' }}>
            {me?.finishPlace === 1 ? 'YOU WIN!' : 'RESULTS'}
          </h1>
          {winner && winner.finishPlace === 1 && <p className="tagline">{winner.name} takes the trophy in {characterInfo(winner.character).name}'s {VEHICLES[winner.carClass as 'drifter']?.label}!</p>}
        </div>
        <div className="podium">
          {rows.map((p) => {
            const place = p.finishPlace ? ordinal(p.finishPlace) : '-';
            const status = p.finishPlace ? 'Finished' : p.status === RacerStatus.LEFT ? 'Left the race' : !p.connected ? 'Disconnected' : 'Did not finish';
            return (
              <div key={p.id} className={`result-row ${p.id === myId ? 'me' : ''} ${p.finishPlace === 1 ? 'p1' : ''}`}>
                <div className="place">{place}</div>
                <Thumb appearance={p} alt={`${p.name}'s car`} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 20 }}>{p.name} <span className="small muted">{p.tag}</span></div>
                  <div className="small muted">{characterInfo(p.character).name} · {VEHICLES[p.carClass as 'drifter']?.label}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="small">{status}</div>
                  <div className="small muted">{p.laps}/{snap.settings.laps} laps</div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="lobby-actions">
          {!net.offline && <Btn variant="ghost" onClick={onLeave}>Leave room</Btn>}
          <Btn onClick={onLobby}>{net.offline ? 'Main menu' : 'Return to lobby'}</Btn>
          <Btn variant="go" onClick={onRematch}>{net.offline ? 'Race again' : 'Rematch (ready up)'}</Btn>
        </div>
      </div>
    </div>
  );
}
