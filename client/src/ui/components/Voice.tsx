import { useSyncExternalStore, type PointerEvent as RPointerEvent } from 'react';
import { voice } from '../../net/Voice';
import { settingsStore, useStore } from '../../state/store';
import { Btn } from './common';
import { input } from '../../input/Input';

/** Phones and tablets: tap the mic once to talk, tap again to stop. */
const tapToTalk = () => input.wantsTouchUI() || input.coarse;

export function useVoice() {
  useSyncExternalStore(voice.subscribe, voice.getVersion, voice.getVersion);
  return voice;
}

const keyName = (code: string) => code.replace(/^Key/, '').replace(/^Digit/, '');

/** Hold-to-talk handlers for a button (mouse, touch or pen). */
function holdProps(id: string) {
  const down = (e: RPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    voice.pttStart(id);
  };
  const up = () => voice.pttEnd(id);
  return { onPointerDown: down, onPointerUp: up, onPointerCancel: up, onLostPointerCapture: up, onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault() };
}

/** Lobby card: join / leave voice, mode, talk button, volume. */
export function VoicePanel() {
  const v = useVoice();
  const settings = useStore(settingsStore);
  if (!v.available) {
    if (!v.supported) return <p className="small muted">Voice chat isn't supported in this browser.</p>;
    return null;
  }
  const talkKey = keyName(settings.bindings.talk[0] ?? 'KeyV');
  if (!v.joined) {
    return (
      <div className="voice-panel card">
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>🎤 Voice chat</h3>
            <p className="small muted">Talk to everyone in this room. Your browser will ask for the microphone.</p>
          </div>
          <Btn variant="sky" onClick={() => void v.join()}>Join voice</Btn>
        </div>
      </div>
    );
  }
  return (
    <div className="voice-panel card stack">
      <div className="row between">
        <h3 style={{ margin: 0 }}>🎤 Voice chat {v.status === 'connecting' ? '· connecting…' : `· ${v.connectedCount()} connected`}</h3>
        <Btn onClick={() => v.leave()}>Leave voice</Btn>
      </div>
      {v.error && <p className="small error-text">{v.error}</p>}
      {v.status !== 'listen-only' && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="seg">
            <button aria-pressed={v.mode === 'ptt'} onClick={() => v.setMode('ptt')}>{tapToTalk() ? 'Tap to talk' : `Push to talk (${talkKey})`}</button>
            <button aria-pressed={v.mode === 'open'} onClick={() => v.setMode('open')}>Open mic</button>
          </div>
          {v.mode === 'ptt' && (tapToTalk()
            ? <button className={`talk-btn ${v.talking ? 'live' : ''}`} onClick={() => v.toggleTalk()}>{v.talking ? '🎙 Mic ON · tap to stop' : '🎙 Tap to talk'}</button>
            : <button className={`talk-btn ${v.talking ? 'live' : ''}`} {...holdProps('lobby')}>{v.talking ? '🎙 Talking…' : '🎙 Hold to talk'}</button>)}
        </div>
      )}
      <label className="small">Voice volume
        <input className="range" type="range" min={0} max={1.5} step={0.05} value={settings.voiceVolume} onChange={(e) => settingsStore.set({ voiceMode: settings.voiceMode, voiceVolume: Number(e.target.value) })} />
      </label>
    </div>
  );
}

/** Per-player voice badge: shows who's in voice / talking; tap to mute them. */
export function VoiceBadge({ id, inVoice, me }: { id: string; inVoice: boolean; me: boolean }) {
  const v = useVoice();
  if (!v.available || !inVoice) return null;
  const talking = v.speaking.has(id);
  const muted = v.muted.has(id);
  if (me) return <span className={`voice-badge ${talking ? 'talking' : ''}`} title="You are in voice">{talking ? '🎙' : '🎤'}</span>;
  return (
    <button className={`voice-badge ${talking ? 'talking' : ''} ${muted ? 'muted' : ''}`} title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute player' : 'Mute player'} onClick={() => v.toggleMute(id)}>
      {muted ? '🔇' : talking ? '🔊' : '🔈'}
    </button>
  );
}

/** Compact in-race control: join, hold to talk (or open-mic toggle), and who's talking. */
export function VoiceHud({ names }: { names: Map<string, string> }) {
  const v = useVoice();
  const settings = useStore(settingsStore);
  if (!v.available) return null;
  const talkers = [...v.speaking].filter((id) => names.has(id));
  if (!v.joined) {
    return <button className="hud-btn voice-hud" aria-label="Join voice chat" title="Join voice chat" onClick={() => void v.join()}>🎤</button>;
  }
  return (
    <div className="voice-hud-wrap">
      {v.status === 'listen-only' ? (
        <button className="hud-btn voice-hud" title="Listening only (no microphone)" aria-label="Leave voice chat" onClick={() => v.leave()}>🔈</button>
      ) : tapToTalk() ? (
        <button className={`hud-btn voice-hud ${v.talking ? 'live' : ''}`} aria-label={v.talking ? 'Mic on, tap to mute' : 'Tap to talk'} title={v.talking ? 'Mic on (tap to stop)' : 'Tap to talk'} onClick={() => v.toggleTalk()}>{v.talking ? '🎙' : '🎤'}</button>
      ) : v.mode === 'ptt' ? (
        <button className={`hud-btn voice-hud ${v.talking ? 'live' : ''}`} aria-label="Hold to talk" title={`Hold to talk (${keyName(settings.bindings.talk[0] ?? 'KeyV')})`} {...holdProps('hud')}>{v.talking ? '🎙' : '🎤'}</button>
      ) : (
        <button className={`hud-btn voice-hud ${v.talking ? 'live' : ''}`} aria-label="Open mic: tap for push to talk" title="Open mic is on (tap for push-to-talk)" onClick={() => v.setMode('ptt')}>🎙</button>
      )}
      {talkers.length > 0 && (
        <div className="talkers">{talkers.slice(0, 4).map((id) => <span key={id} className="talker">🔊 {names.get(id)}</span>)}</div>
      )}
    </div>
  );
}
