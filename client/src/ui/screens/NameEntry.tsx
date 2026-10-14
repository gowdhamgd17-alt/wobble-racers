import { useState } from 'react';
import { NAME_MAX_LENGTH, characterInfo, validateDisplayName } from '@wobble/shared';
import { profileStore, useStore } from '../../state/store';
import { Btn, PreviewBox } from '../components/common';

export function NameEntry({ onContinue, onBack, onGarage, continueLabel }: { onContinue: (name: string) => void; onBack: () => void; onGarage: () => void; continueLabel: string }) {
  const profile = useStore(profileStore);
  const [name, setName] = useState(profile.name);
  const [touched, setTouched] = useState(false);
  const v = validateDisplayName(name);
  const submit = () => {
    setTouched(true);
    if (!v.ok) return;
    profileStore.set({ name: v.value });
    onContinue(v.value);
  };
  return (
    <div className="menu-bg">
      <div className="screen">
        <div className="topbar">
          <Btn variant="ghost icon" aria-label="Back" onClick={onBack}>←</Btn>
          <h2>Who's driving?</h2>
        </div>
        <div className="split">
          <PreviewBox appearance={profile.appearance} label={characterInfo(profile.appearance.character).name} />
          <form className="card stack" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="field">
              <label htmlFor="name">Display name</label>
              <input
                id="name"
                className="input"
                autoFocus
                autoComplete="nickname"
                maxLength={NAME_MAX_LENGTH + 4}
                value={name}
                placeholder="e.g. Turbo Tess"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched(true)}
                aria-invalid={touched && !v.ok}
                aria-describedby="name-err"
              />
              <div className="row between small">
                <span id="name-err" className="error-text">{touched && !v.ok ? v.error : ''}</span>
                <span className="muted">{[...name.trim()].length}/{NAME_MAX_LENGTH}</span>
              </div>
            </div>
            <p className="small muted">No account needed: you play as a guest. Other players see this name in the lobby and race.</p>
            <div className="row">
              <Btn type="button" onClick={onGarage}>Change car & driver</Btn>
              <Btn type="submit" variant="primary" style={{ flex: 1 }}>{continueLabel}</Btn>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
