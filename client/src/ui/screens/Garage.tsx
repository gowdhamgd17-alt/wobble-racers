import { useState } from 'react';
import { BODY_COLORS, CAR_CLASS_IDS, CHARACTERS, VEHICLES, WEAPONS, WHEEL_STYLES, characterInfo, getWeapon, type Appearance } from '@wobble/shared';
import { profileStore, useStore } from '../../state/store';
import { Btn, PreviewBox, StatBars } from '../components/common';
import { audio } from '../../audio/Audio';

type Tab = 'car' | 'weapon' | 'paint' | 'driver';

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
            <PreviewBox appearance={app} focus={tab === 'driver' ? 'driver' : 'car'} label={tab === 'driver' ? characterInfo(app.character).name : tab === 'weapon' ? `${VEHICLES[app.carClass as 'drifter'].label} · ${getWeapon(app.weapon).label}` : `${VEHICLES[app.carClass as 'drifter'].label} · ${characterInfo(app.character).name}`} />
            <p className="small muted">Drag to spin. Colors and wheels are cosmetic; the car class changes handling and armour, and your weapon is what you start every life with.</p>
          </div>
          <div className="card stack">
            <div className="tabs" role="tablist">
              {(['car', 'weapon', 'paint', 'driver'] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => { audio.click(); setTab(t); }}>
                  {t === 'car' ? 'Car' : t === 'weapon' ? 'Weapon' : t === 'paint' ? 'Paint' : 'Driver'}
                </button>
              ))}
            </div>
            {tab === 'car' && (
              <div className="pick-grid">
                {CAR_CLASS_IDS.map((id) => (
                  <button key={id} className="pick" aria-pressed={app.carClass === id} onClick={() => set({ carClass: id })}>
                    <strong>{VEHICLES[id].label} <span className="small muted">· {VEHICLES[id].maxHealth} HP</span></strong>
                    <span className="small">{VEHICLES[id].blurb}</span>
                    <StatBars id={id} />
                  </button>
                ))}
              </div>
            )}
            {tab === 'weapon' && (
              <div className="pick-grid">
                {WEAPONS.map((w) => (
                  <button key={w.id} className="pick" aria-pressed={app.weapon === w.id} onClick={() => { set({ weapon: w.id }); audio.reloaded(w.id); }}>
                    <strong>{w.label}</strong>
                    <span className="small">{w.blurb}</span>
                    <span className="small muted">{w.pellets > 1 ? `${w.pellets} × ${w.damage}` : w.damage} dmg{w.splash ? ` + ${w.splash} blast` : ''} · {w.magazine} rounds · {w.reload}s reload</span>
                    <div className="stack" style={{ gap: 3, width: '100%' }}>
                      {(['damage', 'rate', 'range'] as const).map((k) => (
                        <div className="statbar" key={k}><span>{k === 'rate' ? 'Fire rate' : k[0].toUpperCase() + k.slice(1)}</span><span className="bar"><i style={{ width: `${w.stats[k] * 100}%` }} /></span></div>
                      ))}
                    </div>
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
