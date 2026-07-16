"use client";

import { useApp } from "@/lib/store";
import type { Lang } from "@/lib/i18n";

export default function SettingsPage() {
  const { t, settings, setSettings, toast } = useApp();

  const update = (patch: Parameters<typeof setSettings>[0]) => {
    setSettings(patch);
    toast(t.settingsSaved);
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 font-display text-2xl font-bold">{t.settingsTitle}</h1>
      <div className="panel space-y-5 p-5">
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-ink/60 dark:text-paper/60">
            {t.setLanguage}
          </label>
          <select
            className="field"
            value={settings.lang}
            onChange={(e) => update({ lang: e.target.value as Lang })}
          >
            <option value="bg">Български</option>
            <option value="en">English</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-ink/60 dark:text-paper/60">
            {t.setTheme}
          </label>
          <select
            className="field"
            value={settings.theme}
            onChange={(e) => update({ theme: e.target.value as "dark" | "light" })}
          >
            <option value="dark">{t.themeDark}</option>
            <option value="light">{t.themeLight}</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-ink/60 dark:text-paper/60">
            {t.setPrecision}
          </label>
          <select
            className="field readout"
            value={settings.precision}
            onChange={(e) => update({ precision: parseInt(e.target.value, 10) })}
          >
            {[0, 1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-ink/60 dark:text-paper/60">
            {t.setSmoothing}
          </label>
          <select
            className="field readout"
            value={settings.smoothing}
            onChange={(e) => update({ smoothing: parseInt(e.target.value, 10) })}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                ×{n}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs uppercase tracking-wide text-ink/60 dark:text-paper/60">
            DPI на скенера
          </label>
          <input
            className="field readout"
            type="number"
            min={72}
            max={2400}
            step={1}
            value={settings.scannerDpi}
            onChange={(e) => update({ scannerDpi: Math.max(72, parseInt(e.target.value, 10) || 300) })}
          />
          <p className="mt-1 text-xs text-ink/50 dark:text-paper/50">
            За твоя A3 2400S скенер остави 300 DPI. Това запазва реалния мащаб в mm, DXF и SVG.
          </p>
        </div>
      </div>
    </div>
  );
}
