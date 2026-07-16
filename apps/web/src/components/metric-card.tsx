import { LucideIcon } from "lucide-react";

type MetricCardProps = {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
};

export function MetricCard({ label, value, detail, icon: Icon }: MetricCardProps) {
  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-foreground/55">{label}</p>
          <strong className="mt-2 block text-2xl font-semibold">{value}</strong>
        </div>
        <span className="rounded-md border border-border bg-muted p-2 text-foreground/70">
          <Icon size={18} />
        </span>
      </div>
      <p className="mt-3 text-sm text-foreground/60">{detail}</p>
    </article>
  );
}
