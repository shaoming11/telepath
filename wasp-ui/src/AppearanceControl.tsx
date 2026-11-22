import { useEffect, useLayoutEffect, useState } from 'react';

type Appearance = 'automatic' | 'solid';

const STORAGE_KEY = 'telepathy.wasp.appearance';

function readAppearance(): Appearance {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'solid' ? 'solid' : 'automatic';
  } catch {
    return 'automatic';
  }
}

export function AppearanceControl({ className }: { className?: string }) {
  const [appearance, set_appearance] = useState<Appearance>(readAppearance);

  useLayoutEffect(() => {
    document.body.toggleAttribute('data-solid-surfaces', appearance === 'solid');
    return () => document.body.removeAttribute('data-solid-surfaces');
  }, [appearance]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) set_appearance(readAppearance());
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function changeAppearance(next: Appearance) {
    set_appearance(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }

  return (
    <div className={className}>
      <label className="appearance-setting">
        <span>Appearance</span>
        <span className="appearance-setting__input">
          <select value={appearance} onChange={event => changeAppearance(event.currentTarget.value === 'solid' ? 'solid' : 'automatic')}>
            <option value="automatic">Automatic</option>
            <option value="solid">Solid surfaces</option>
          </select>
        </span>
      </label>
    </div>
  );
}
