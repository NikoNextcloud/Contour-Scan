"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { dictionaries, type Dict, type Lang } from "./i18n";

/* ---------------------------------- settings ---------------------------------- */

export interface Settings {
  lang: Lang;
  theme: "dark" | "light";
  /** Decimal places in exported mm values / UI readouts. */
  precision: number;
  /** Default Chaikin smoothing iterations applied by the editor's Smooth tool. */
  smoothing: number;
}

const DEFAULT_SETTINGS: Settings = { lang: "bg", theme: "dark", precision: 2, smoothing: 1 };
const SETTINGS_KEY = "contourscan.settings";

interface AppState {
  settings: Settings;
  setSettings: (patch: Partial<Settings>) => void;
  t: Dict;
  toast: (msg: string, kind?: "ok" | "err") => void;
}

const AppContext = createContext<AppState | null>(null);

interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "err";
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Hydrate persisted settings once on the client.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) setSettingsState({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {
      /* corrupted storage — keep defaults */
    }
  }, []);

  // Reflect theme on <html> for Tailwind's dark: variant.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
    document.documentElement.lang = settings.lang;
  }, [settings.theme, settings.lang]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* storage full/unavailable */
      }
      return next;
    });
  }, []);

  const toast = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);

  const value = useMemo<AppState>(
    () => ({ settings, setSettings, t: dictionaries[settings.lang], toast }),
    [settings, setSettings, toast]
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      {/* Toast stack */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`animate-toast rounded-lg px-4 py-2.5 font-mono text-sm shadow-lg ${
              t.kind === "ok"
                ? "bg-ink text-paper dark:bg-paper dark:text-ink"
                : "bg-red-600 text-white"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}

/** Format a pixel value as mm using calibration + precision, or fall back to px. */
export function fmtDim(
  px: number,
  mmPerPx: number | null | undefined,
  precision: number,
  unitMm: string,
  unitPx: string,
  power = 1
): string {
  if (mmPerPx) {
    const v = px * Math.pow(mmPerPx, power);
    return `${v.toFixed(precision)} ${unitMm}${power === 2 ? "²" : ""}`;
  }
  return `${px.toFixed(power === 2 ? 0 : 1)} ${unitPx}${power === 2 ? "²" : ""}`;
}
