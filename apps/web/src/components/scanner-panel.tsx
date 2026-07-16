"use client";

import { ChangeEvent, useMemo, useState } from "react";
import { Camera, FileImage, Ruler, Sparkles, UploadCloud } from "lucide-react";
import { Button } from "@/components/button";
import { apiBaseUrl, demoMeasurements } from "@/lib/utils";

export function ScannerPanel() {
  const [fileName, setFileName] = useState("demo-gasket.webp");
  const [status, setStatus] = useState("Ready for scan");
  const [isProcessing, setIsProcessing] = useState(false);

  const progress = useMemo(() => (isProcessing ? 68 : 100), [isProcessing]);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) {
      setFileName(file.name);
      setStatus("Image loaded");
    }
  }

  async function runDemoScan() {
    setIsProcessing(true);
    setStatus("Detecting outer contour...");
    try {
      await fetch(`${apiBaseUrl}/health`, { cache: "no-store" });
      setStatus("API connected. Demo contour generated.");
    } catch {
      setStatus("Local demo mode. Backend URL can be added in Vercel.");
    } finally {
      setTimeout(() => setIsProcessing(false), 600);
    }
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <div className="rounded-lg border border-border bg-card p-5 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-foreground/60">Scanner</p>
            <h2 className="text-2xl font-semibold">Upload, calibrate, detect</h2>
          </div>
          <Button onClick={runDemoScan}>
            <Sparkles size={17} /> Scan
          </Button>
        </div>

        <label className="mt-5 flex min-h-64 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-foreground/25 bg-muted/55 p-6 text-center transition hover:border-foreground/55">
          <UploadCloud size={38} className="text-foreground/60" />
          <span className="mt-3 text-lg font-semibold">Drop photo or choose file</span>
          <span className="mt-1 text-sm text-foreground/55">JPG, PNG, WEBP, HEIC up to 100 MB</span>
          <input className="sr-only" type="file" accept="image/*,.heic" onChange={onFileChange} />
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-background p-3">
            <FileImage size={18} />
            <p className="mt-2 truncate text-sm font-medium">{fileName}</p>
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <Ruler size={18} />
            <p className="mt-2 text-sm font-medium">Credit card calibration</p>
          </div>
          <div className="rounded-md border border-border bg-background p-3">
            <Camera size={18} />
            <p className="mt-2 text-sm font-medium">Camera ready</p>
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between text-sm">
            <span>{status}</span>
            <span>{progress}%</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-muted">
            <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      </div>

      <aside className="rounded-lg border border-border bg-card p-5 shadow-soft">
        <p className="text-sm font-medium text-foreground/60">Measurements</p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Measurement label="Width" value={`${demoMeasurements.widthMm} mm`} />
          <Measurement label="Height" value={`${demoMeasurements.heightMm} mm`} />
          <Measurement label="Area" value={`${(demoMeasurements.areaMm2 / 100).toFixed(1)} cm2`} />
          <Measurement label="Perimeter" value={`${demoMeasurements.perimeterMm} mm`} />
        </div>
        <div className="mt-4 rounded-md border border-border bg-background p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-foreground/60">Contour confidence</span>
            <strong>{demoMeasurements.confidence}%</strong>
          </div>
          <div className="mt-3 h-2 rounded-full bg-muted">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${demoMeasurements.confidence}%` }} />
          </div>
        </div>
      </aside>
    </section>
  );
}

function Measurement({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs uppercase tracking-wide text-foreground/50">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
