import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { CAR_CLASS_IDS, VEHICLES, type Appearance } from '@wobble/shared';
import { audio } from '../../audio/Audio';
import { CarPreview, carThumbnail } from '../../game/Preview';
import { webglAvailable } from '../../game/Game';

export function Btn({ variant = '', className = '', onClick, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button
      {...rest}
      className={`btn ${variant} ${className}`}
      onClick={(e) => {
        audio.click();
        onClick?.(e);
      }}
    />
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="knob" aria-hidden />
    </label>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, disabled, render }: { options: readonly T[]; value: T; onChange: (v: T) => void; disabled?: boolean; render?: (v: T) => ReactNode }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={String(o)} type="button" aria-pressed={o === value} disabled={disabled} onClick={() => { audio.click(); onChange(o); }}>
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; text: string; kind: 'info' | 'error' }
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = ++idRef.current;
    setToasts((t) => [...t.filter((x) => x.text !== text), { id, text, kind }].slice(-3));
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ previews
export function PreviewBox({ appearance, label, focus = 'car' }: { appearance: Appearance; label?: string; focus?: 'car' | 'driver' }) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<CarPreview | null>(null);
  const [ok] = useState(() => webglAvailable());
  useEffect(() => {
    if (!ok || !ref.current) return;
    prev.current = new CarPreview(ref.current);
    return () => { prev.current?.dispose(); prev.current = null; };
  }, [ok]);
  useEffect(() => { prev.current?.setAppearance(appearance); }, [appearance, ok]);
  useEffect(() => { prev.current?.setFocus(focus); }, [focus, ok]);
  return (
    <div className="preview-wrap" ref={ref}>
      {!ok && <div className="center-msg" style={{ padding: 16 }}>3D preview needs WebGL, which this browser doesn't support.</div>}
      {label && <div className="preview-label">{label}</div>}
    </div>
  );
}

export function Thumb({ appearance, alt }: { appearance: Appearance; alt: string }) {
  const [src, setSrc] = useState('');
  const key = [appearance.carClass, appearance.character, appearance.colorMain, appearance.colorSecondary, appearance.colorWheel, appearance.wheelStyle].join('|');
  useEffect(() => {
    let alive = true;
    // Render off the critical path
    const a: Appearance = { carClass: appearance.carClass, character: appearance.character, colorMain: appearance.colorMain, colorSecondary: appearance.colorSecondary, colorWheel: appearance.colorWheel, wheelStyle: appearance.wheelStyle };
    const id = requestAnimationFrame(() => { if (alive) setSrc(webglAvailable() ? carThumbnail(a) : ''); });
    return () => { alive = false; cancelAnimationFrame(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return src ? <img src={src} alt={alt} draggable={false} /> : <img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />;
}

export function StatBars({ id }: { id: string }) {
  const v = VEHICLES[id as (typeof CAR_CLASS_IDS)[number]];
  if (!v) return null;
  const rows: [string, number][] = [['Speed', v.stats.speed], ['Accel', v.stats.accel], ['Handling', v.stats.handling], ['Armor', v.stats.armor], ['Power', v.stats.power]];
  return (
    <div className="stack" style={{ gap: 3 }}>
      {rows.map(([k, n]) => (
        <div className="statbar" key={k}><span>{k}</span><span className="bar"><i style={{ width: `${n * 100}%` }} /></span></div>
      ))}
    </div>
  );
}
