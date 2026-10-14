import { useState } from 'react';
import { BODY_COLORS, CAR_CLASS_IDS, CHARACTERS, VEHICLES, WHEEL_STYLES, characterInfo, type Appearance } from '@wobble/shared';
import { profileStore, useStore } from '../../state/store';
import { Btn, PreviewBox, StatBars } from '../components/common';
import { audio } from '../../audio/Audio';

type Tab = 'car' | 'paint' | 'driver';

export function Garage({ onDone, initialTab = 'car', confirmLabel = 'Confirm' }: { onDone: (a: Appearance) => void; initialTab?: Tab; confirmLabel?: string }) {
  const profile = useStore(profileStore);
  const [app, setApp] = useState<Appearance>(profile.appearance);
  const [tab, setTab] = useState<Tab>(initialTab);
  const set = (p: Partial<Appearance>) => { audio.click(); setApp((a) => ({ ...a, ...p })); };

  const Swatches = ({ k }: { k: 'colorMain' | 'colorSecondary' | 'colorWheel' }) => (
    <div className="swatches">
      {BODY_COLORS.map((c) => (
        <button key={c.id} className="swatch" style={{ background: c.hex }} aria-label={c.label} title={c.label} aria-pressed={app[k] === c.id} onClick={() => set({ [k]: c.id })} />
      ))}
    </div>
  );

  return (
    <div className="menu-bg">
      <div className="screen">
        <div className="topbar">
          <h2>Garage</h2>
          <Btn variant="ghost" onClick={() => onDone(profile.appearance)}>Cancel</Btn>
          <Btn variant="primary" onClick={() => { profileStore.set({ appearance: app }); onDone(app); }}>{confirmLabel}</Btn>
        </div>
        <div className="split">
          <div className="stack">
            <PreviewBox appearance={app} label={`${VEHICLES[app.carClass as 'drifter'].label} · ${characterInfo(app.character).name}`} />
            <p className="small muted">Drag to spin. Colors and wheels are cosmetic only; car class changes handling.</p>
          </div>
          <div className="card stack">
            <div className="tabs" role="tablist">
              {(['car', 'paint', 'driver'] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => { audio.click(); setTab(t); }}>
                  {t === 'car' ? 'Car' : t === 'paint' ? 'Paint & wheels' : 'Driver'}
                </button>
              ))}
            </div>
            {tab === 'car' && (
              <div className="pick-grid">
                {CAR_CLASS_IDS.map((id) => (
                  <button key={id} className="pick" aria-pressed={app.carClass === id} onClick={() => set({ carClass: id })}>
                    <strong>{VEHICLES[id].label}</strong>
                    <span className="small">{VEHICLES[id].blurb}</span>
                    <StatBars id={id} />
                  </button>
                ))}
              </div>
            )}
            {tab === 'paint' && (
              <div className="stack">
                <div className="field"><label>Body color</label><Swatches k="colorMain" /></div>
                <div className="field"><label>Trim color</label><Swatches k="colorSecondary" /></div>
                <div className="field"><label>Wheel color</label><Swatches k="colorWheel" /></div>
                <div className="field">
                  <label>Wheel style</label>
                  <div className="seg">
                    {WHEEL_STYLES.map((w) => (
                      <button key={w.id} aria-pressed={app.wheelStyle === w.id} onClick={() => set({ wheelStyle: w.id })}>{w.label}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {tab === 'driver' && (
              <div className="pick-grid">
                {CHARACTERS.map((c) => (
                  <button key={c.id} className="pick" aria-pressed={app.character === c.id} onClick={() => set({ character: c.id })}>
                    <span className="row" style={{ gap: 4 }}>{c.palette.map((p) => <span key={p} className="dot" style={{ background: p }} />)}</span>
                    <strong>{c.name}</strong>
                    <span className="small">{c.personality}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
