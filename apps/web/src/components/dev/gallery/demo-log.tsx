'use client';

/**
 * DEV-ONLY: every button of the gallery reports what the real page would do, in a live region at the
 * bottom of the screen (no silent button, even in the kit).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Log = (label: string) => () => void;

const DemoLogContext = createContext<Log>(() => () => undefined);

export function DemoLogProvider({ children }: { children: ReactNode }) {
  const [last, setLast] = useState<{ label: string; n: number } | null>(null);
  const log = useCallback<Log>((label) => () => setLast((prev) => ({ label, n: (prev?.n ?? 0) + 1 })), []);
  const value = useMemo(() => log, [log]);
  return (
    <DemoLogContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-6 bottom-6 z-50 max-w-[420px] rounded-md bg-near-black px-4 py-3 font-sans text-app-13 text-paper shadow-float empty:hidden"
      >
        {last ? `Galerie · action « ${last.label} » (n° ${last.n}) — la page réelle l'envoie au serveur.` : null}
      </div>
    </DemoLogContext.Provider>
  );
}

/** `const demo = useDemo(); <Button onClick={demo('Préparer le commit')} />` */
export function useDemo(): Log {
  return useContext(DemoLogContext);
}
