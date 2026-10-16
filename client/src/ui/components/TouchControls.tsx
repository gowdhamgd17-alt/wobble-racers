// On-screen controls for phones and tablets: arrow buttons to steer, drive
// forward and reverse, plus NITRO and FIRE (and smaller drift / gun / reload
// buttons). Every button can be moved and resized in "Customize controls";
// the layout is saved on the device.

import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { haptic, input } from '../../input/Input';
import { settingsStore, useStore, type Action, type TouchSpot } from '../../state/store';

interface ControlDef {
  id: string;
  action: Action;
  label: string;
  icon?: 'left' | 'right' | 'up' | 'down' | 'fire' | 'nitro';
  x: number; // default centre, % of screen width
  y: number; // default centre, % of screen height
  s: number; // default size multiplier
  cls?: string;
  needsWeapons?: boolean;
  needsNitro?: boolean;
}

export const CONTROLS: ControlDef[] = [
  { id: 'left', action: 'left', label: 'Left', icon: 'left', x: 9, y: 76, s: 1.15, cls: 'steer' },
  { id: 'right', action: 'right', label: 'Right', icon: 'right', x: 24, y: 76, s: 1.15, cls: 'steer' },
  { id: 'forward', action: 'accelerate', label: 'Forward', icon: 'up', x: 91, y: 50, s: 1.2, cls: 'gas' },
  { id: 'back', action: 'brake', label: 'Back', icon: 'down', x: 91, y: 81, s: 1.05, cls: 'brake' },
  { id: 'fire', action: 'fire', label: 'Fire', icon: 'fire', x: 77, y: 76, s: 1.15, cls: 'fire', needsWeapons: true },
  { id: 'nitro', action: 'nitro', label: 'Nitro', icon: 'nitro', x: 77, y: 47, s: 0.95, cls: 'nitro', needsNitro: true },
  { id: 'drift', action: 'drift', label: 'DRIFT', x: 63, y: 87, s: 0.72 },
  { id: 'gun', action: 'nextWeapon', label: 'GUN ▸', x: 63, y: 64, s: 0.68, needsWeapons: true },
  { id: 'reload', action: 'reload', label: 'RELOAD', x: 51, y: 87, s: 0.68, needsWeapons: true },
];

const ICONS: Record<string, JSX.Element> = {
  left: <svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  right: <svg viewBox="0 0 24 24"><path d="m9 4 8 8-8 8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  up: <svg viewBox="0 0 24 24"><path d="M4 15 12 7l8 8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  down: <svg viewBox="0 0 24 24"><path d="m4 9 8 8 8-8" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  fire: <svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="7" /><path d="M12 2v5M12 17v5M2 12h5M17 12h5" /></g><circle cx="12" cy="12" r="1.8" fill="currentColor" /></svg>,
  nitro: <svg viewBox="0 0 24 24"><path d="M13 2 5 13h6l-1 9 8-11h-6z" fill="currentColor" /></svg>,
};

export function spotFor(c: ControlDef, layout: Record<string, TouchSpot>): TouchSpot {
  return layout[c.id] ?? { x: c.x, y: c.y, s: c.s };
}

export function TouchControls({ weaponsOn, nitroOn, editing, onDoneEditing }: { weaponsOn: boolean; nitroOn: boolean; editing: boolean; onDoneEditing: () => void }) {
  const settings = useStore(settingsStore);
  const [down, setDown] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, TouchSpot>>(settings.touchLayout);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; pointer: number; dx: number; dy: number } | null>(null);

  useEffect(() => () => input.resetAll(), []);
  useEffect(() => { if (editing) { setDraft(settingsStore.get().touchLayout); setSelected(null); input.resetAll(); } }, [editing]);

  const layout = editing ? draft : settings.touchLayout;
  const visible = CONTROLS.filter((c) => (!c.needsWeapons || weaponsOn) && (!c.needsNitro || nitroOn));
  const refresh = () => {
    const s = new Set<string>();
    for (const c of CONTROLS) if (input.isDown(c.action)) s.add(c.id);
    setDown(s);
  };

  // ---- playing
  const press = (c: ControlDef) => (e: RPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    input.pointerDown(e.pointerId, c.action);
    if (c.action === 'fire' || c.action === 'nitro') haptic(10);
    refresh();
  };
  const release = (e: RPointerEvent) => { input.pointerUp(e.pointerId); refresh(); };
  // Slide a thumb between the left and right arrows without lifting it.
  const slide = (c: ControlDef) => (e: RPointerEvent) => {
    if (c.cls !== 'steer') return;
    const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => (x as HTMLElement).dataset?.steer);
    const a = (el as HTMLElement | undefined)?.dataset.steer as Action | undefined;
    if (a && a !== c.action) { input.pointerMove(e.pointerId, a); refresh(); }
  };

  // ---- editing
  const toPct = (clientX: number, clientY: number) => {
    const r = root.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * 100, y: ((clientY - r.top) / r.height) * 100 };
  };
  const editDown = (c: ControlDef) => (e: RPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const sp = spotFor(c, draft);
    const p = toPct(e.clientX, e.clientY);
    drag.current = { id: c.id, pointer: e.pointerId, dx: sp.x - p.x, dy: sp.y - p.y };
    setSelected(c.id);
  };
  const editMove = (c: ControlDef) => (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || d.id !== c.id) return;
    const p = toPct(e.clientX, e.clientY);
    const sp = spotFor(c, draft);
    setDraft({ ...draft, [c.id]: { x: Math.min(97, Math.max(3, p.x + d.dx)), y: Math.min(96, Math.max(4, p.y + d.dy)), s: sp.s } });
  };
  const editUp = () => { drag.current = null; };
  const resize = (k: number) => {
    if (!selected) return;
    const c = CONTROLS.find((x) => x.id === selected)!;
    const sp = spotFor(c, draft);
    setDraft({ ...draft, [c.id]: { ...sp, s: Math.min(2, Math.max(0.5, +(sp.s * k).toFixed(2))) } });
  };
  const save = () => { settingsStore.set({ touchLayout: draft }); onDoneEditing(); };

  return (
    <div className={`touch ${editing ? 'editing' : ''}`} ref={root}>
      {visible.map((c) => {
        const sp = spotFor(c, layout);
        const style = {
          left: `${sp.x}%`, top: `${sp.y}%`,
          ['--size' as string]: `calc(var(--tb) * ${sp.s})`,
        };
        const handlers = editing
          ? { onPointerDown: editDown(c), onPointerMove: editMove(c), onPointerUp: editUp, onPointerCancel: editUp }
          : { onPointerDown: press(c), onPointerMove: slide(c), onPointerUp: release, onPointerCancel: release, onLostPointerCapture: release };
        return (
          <div
            key={c.id}
            className={`tbtn ${c.cls ?? ''} ${down.has(c.id) ? 'down' : ''} ${selected === c.id ? 'selected' : ''} ${c.icon ? 'icon' : 'text'}`}
            style={style}
            role="button"
            aria-label={c.label}
            data-steer={c.cls === 'steer' ? c.action : undefined}
            {...handlers}
          >
            {c.icon ? ICONS[c.icon] : c.label}
            {c.icon === 'fire' && <span className="tlabel">FIRE</span>}
            {c.icon === 'nitro' && <span className="tlabel">NITRO</span>}
          </div>
        );
      })}
      {editing && (
        <div className="touch-editbar">
          <span className="small">{selected ? `Selected: ${CONTROLS.find((c) => c.id === selected)!.label}` : 'Drag any button to move it. Tap one to resize it.'}</span>
          <button disabled={!selected} onClick={() => resize(1 / 1.12)} aria-label="Smaller">−</button>
          <button disabled={!selected} onClick={() => resize(1.12)} aria-label="Bigger">+</button>
          <button onClick={() => { setDraft({}); setSelected(null); }}>Reset</button>
          <button className="primary" onClick={save}>Done</button>
        </div>
      )}
    </div>
  );
}
