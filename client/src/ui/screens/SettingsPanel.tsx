import { useEffect, useState } from 'react';
import { DEFAULT_BINDINGS, settingsStore, useStore, type Action, type ControlMode, type Quality } from '../../state/store';
import { Btn, Segmented, Toggle } from '../components/common';

const ACTION_LABELS: Record<Action, string> = {
  accelerate: 'Accelerate', brake: 'Brake / reverse', left: 'Steer left', right: 'Steer right',
  drift: 'Handbrake / drift', nitro: 'Nitro', fire: 'Fire blaster', recover: 'Recover car', pause: 'Pause',
};

function keyLabel(code: string) {
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', '').replace('Left', ' L').replace('Right', ' R').trim();
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = useStore(settingsStore);
  const [rebinding, setRebinding] = useState<Action | null>(null);

  useEffect(() => {
    if (!rebinding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape' || rebinding === 'pause') {
        const bindings = { ...s.bindings };
        // remove this key from other actions to avoid conflicts
        for (const a of Object.keys(bindings) as Action[]) bindings[a] = bindings[a].filter((k) => k !== e.code);
        bindings[rebinding] = [e.code, ...bindings[rebinding].filter((k) => k !== e.code)].slice(0, 2);
        settingsStore.set({ bindings });
      }
      setRebinding(null);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [rebinding, s.bindings]);

  return (
    <div className="stack">
      <div className="row between">
        <h3 style={{ margin: 0 }}>Settings</h3>
        <Btn variant="primary" onClick={onClose}>Done</Btn>
      </div>

      <div className="field">
        <label>Controls</label>
        <Segmented<ControlMode> options={['auto', 'touch', 'keyboard']} value={s.controlMode} onChange={(v) => settingsStore.set({ controlMode: v })}
          render={(v) => (v === 'auto' ? 'Auto-detect' : v === 'touch' ? 'Touch buttons' : 'Keyboard')} />
        <span className="small muted">Auto switches to whatever you used last, so hybrid laptops work either way.</span>
      </div>
      <div className="field">
        <label>Graphics quality</label>
        <Segmented<Quality> options={['auto', 'low', 'medium', 'high']} value={s.quality} onChange={(v) => settingsStore.set({ quality: v })}
          render={(v) => v[0].toUpperCase() + v.slice(1)} />
      </div>
      <div className="field">
        <label>Sound effects: {Math.round(s.sfxVolume * 100)}%</label>
        <input className="range" type="range" min={0} max={1} step={0.05} value={s.sfxVolume} onChange={(e) => settingsStore.set({ sfxVolume: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>Music: {Math.round(s.musicVolume * 100)}%</label>
        <input className="range" type="range" min={0} max={1} step={0.05} value={s.musicVolume} onChange={(e) => settingsStore.set({ musicVolume: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>Camera follow speed: {s.cameraSensitivity.toFixed(1)}×</label>
        <input className="range" type="range" min={0.5} max={2} step={0.1} value={s.cameraSensitivity} onChange={(e) => settingsStore.set({ cameraSensitivity: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>Touch button size: {Math.round(s.touchScale * 100)}%</label>
        <input className="range" type="range" min={0.8} max={1.3} step={0.05} value={s.touchScale} onChange={(e) => settingsStore.set({ touchScale: Number(e.target.value) })} />
      </div>
      <Toggle label="Auto-gas on touch (hold Brake to slow)" checked={s.autoGas} onChange={(v) => settingsStore.set({ autoGas: v })} />
      <Toggle label="Vibration (where supported)" checked={s.haptics} onChange={(v) => settingsStore.set({ haptics: v })} />
      <Toggle label="Show FPS" checked={s.showFps} onChange={(v) => settingsStore.set({ showFps: v })} />

      <div className="field">
        <div className="row between">
          <label>Keyboard bindings</label>
          <button className="btn icon" style={{ minHeight: 36, fontSize: 14 }} onClick={() => settingsStore.set({ bindings: DEFAULT_BINDINGS })}>Reset</button>
        </div>
        {(Object.keys(ACTION_LABELS) as Action[]).map((a) => (
          <div key={a} className="binding-row">
            <span>{ACTION_LABELS[a]}</span>
            <button className="btn" style={{ minHeight: 38, fontSize: 15, padding: '4px 10px' }} onClick={() => setRebinding(a)}>
              {rebinding === a ? 'Press a key…' : s.bindings[a].map((k) => <span key={k} className="kbd">{keyLabel(k)}</span>)}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
