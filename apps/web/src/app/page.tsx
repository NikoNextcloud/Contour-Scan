"use client";

import dynamic from "next/dynamic";
import {
  Activity,
  Archive,
  Bot,
  Boxes,
  BrainCircuit,
  Database,
  Download,
  FileCode2,
  Gauge,
  GitBranch,
  Grid2X2,
  Layers3,
  RotateCcw,
  ScanLine,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UploadCloud
} from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/button";
import { MetricCard } from "@/components/metric-card";
import { ScannerPanel } from "@/components/scanner-panel";
import { demoContour, exportOptions, objectClasses } from "@/lib/utils";

const EditorCanvas = dynamic(
  () => import("@/components/editor-canvas").then((module) => module.EditorCanvas),
  { ssr: false }
);

const navItems = ["Home", "Scanner", "Editor", "Library", "Exports", "Settings"];

export default function Home() {
  return (
    <main className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-card/88 px-4 py-5 backdrop-blur xl:block">
        <div className="flex items-center gap-3 px-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-foreground text-background">
            <ScanLine size={21} />
          </span>
          <div>
            <p className="text-sm text-foreground/55">Manufacturing AI</p>
            <h1 className="font-semibold">ContourScan AI</h1>
          </div>
        </div>
        <nav className="mt-8 space-y-1">
          {navItems.map((item, index) => (
            <a
              key={item}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted ${
                index === 1 ? "bg-muted font-medium" : "text-foreground/68"
              }`}
              href={`#${item.toLowerCase()}`}
            >
              {index === 0 && <Grid2X2 size={17} />}
              {index === 1 && <UploadCloud size={17} />}
              {index === 2 && <SlidersHorizontal size={17} />}
              {index === 3 && <Database size={17} />}
              {index === 4 && <Download size={17} />}
              {index === 5 && <Settings size={17} />}
              {item}
            </a>
          ))}
        </nav>
      </aside>

      <div className="xl:pl-64">
        <header className="sticky top-0 z-20 border-b border-border bg-background/82 px-4 py-3 backdrop-blur md:px-8">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-foreground/52">GitHub + Vercel ready</p>
              <h2 className="text-lg font-semibold">Contour extraction command center</h2>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary">
                <GitBranch size={17} /> GitHub
              </Button>
              <Button>
                <Download size={17} /> Export
              </Button>
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]"
          >
            <div className="rounded-lg border border-border bg-card p-6 shadow-soft">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div>
                  <p className="text-sm font-medium text-foreground/58">CNC, laser, vinyl, CAD</p>
                  <h1 className="mt-2 max-w-3xl text-4xl font-semibold leading-tight md:text-5xl">
                    Photo to precise production contour.
                  </h1>
                  <p className="mt-4 max-w-2xl text-base leading-7 text-foreground/68">
                    Extract outer contours, detect holes, calibrate measurements, edit points, learn from corrections,
                    and export clean files for manufacturing workflows.
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-background p-4">
                  <p className="text-xs uppercase tracking-wide text-foreground/50">AI suggestion</p>
                  <p className="mt-2 text-2xl font-semibold">98.6%</p>
                  <p className="text-sm text-foreground/60">Gasket contour confidence</p>
                </div>
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                {["Outer contour", "Holes", "Cut path", "DXF", "SVG", "G-Code", "Reports"].map((item) => (
                  <span key={item} className="rounded-md border border-border bg-muted px-3 py-1 text-sm">
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-card p-6 shadow-soft">
              <p className="text-sm font-medium text-foreground/58">Smart contour learning</p>
              <div className="mt-4 space-y-4">
                {[
                  ["Shape match", "97.8%", "Previous rubber seal template"],
                  ["Edit reduction", "42%", "Based on approved corrections"],
                  ["Detection success", "94.3%", "Across saved scans"]
                ].map(([label, value, detail]) => (
                  <div key={label} className="rounded-md border border-border bg-background p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground/60">{label}</span>
                      <strong>{value}</strong>
                    </div>
                    <p className="mt-1 text-sm text-foreground/55">{detail}</p>
                  </div>
                ))}
              </div>
            </div>
          </motion.section>

          <section className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Activity} label="Total scans" value="1,284" detail="History with thumbnails and exports" />
            <MetricCard icon={Gauge} label="Avg accuracy" value="96.8%" detail="Validated by feedback ratings" />
            <MetricCard icon={Layers3} label="CAD exports" value="7" detail="DXF, SVG, PNG, PDF, JSON, CSV, G-Code" />
            <MetricCard icon={ShieldCheck} label="Pipeline" value="OpenCV" detail="Replaceable AI model architecture" />
          </section>

          <div id="scanner" className="mt-4">
            <ScannerPanel />
          </div>

          <section id="editor" className="mt-4 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="rounded-lg border border-border bg-card p-5 shadow-soft">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-foreground/58">Interactive editor</p>
                  <h2 className="text-2xl font-semibold">Manual contour correction</h2>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary">
                    <RotateCcw size={17} /> Undo
                  </Button>
                  <Button variant="secondary">
                    <Sparkles size={17} /> Smooth
                  </Button>
                </div>
              </div>
              <EditorCanvas initialPoints={demoContour} />
            </div>

            <div className="space-y-4">
              <Panel title="CAD tools" icon={FileCode2}>
                {["Detect internal contours", "Separate holes and slots", "Offset inside or outside cuts", "Lead-in and lead-out generator", "DXF overlay comparison"].map((item) => (
                  <CheckRow key={item} label={item} />
                ))}
              </Panel>
              <Panel title="Export formats" icon={Archive}>
                <div className="grid grid-cols-2 gap-2">
                  {exportOptions.map((option) => (
                    <button key={option} className="rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-muted">
                      {option}
                    </button>
                  ))}
                </div>
              </Panel>
            </div>
          </section>

          <section id="library" className="mt-4 grid gap-4 lg:grid-cols-3">
            <Panel title="Object library" icon={Boxes}>
              <div className="grid grid-cols-2 gap-2">
                {objectClasses.map((item) => (
                  <span key={item} className="rounded-md border border-border bg-background px-3 py-2 text-sm">
                    {item}
                  </span>
                ))}
              </div>
            </Panel>
            <Panel title="AI feedback loop" icon={BrainCircuit}>
              {["Store approved corrections", "Rank reusable templates", "Generate vector embeddings", "Export COCO, YOLO, Pascal VOC"].map((item) => (
                <CheckRow key={item} label={item} />
              ))}
            </Panel>
            <Panel title="Assistant" icon={Bot}>
              {["Suggest smoothing level", "Explain measurements", "Recommend export settings", "Generate PDF reports"].map((item) => (
                <CheckRow key={item} label={item} />
              ))}
            </Panel>
          </section>
        </div>
      </div>
    </main>
  );
}

function Panel({
  title,
  icon: Icon,
  children
}: {
  title: string;
  icon: typeof Activity;
  children: React.ReactNode;
}) {
  return (
    <article className="rounded-lg border border-border bg-card p-5 shadow-soft">
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-md border border-border bg-muted p-2">
          <Icon size={18} />
        </span>
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      {children}
    </article>
  );
}

function CheckRow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-foreground/70">{label}</span>
      <span className="h-2 w-2 rounded-full bg-emerald-500" />
    </div>
  );
}
