import { Panel } from "./Panel";
import type { ResponseMetrics } from "@/lib/types";

function Metric({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="rounded-lg border border-border bg-canvas px-2 py-1.5 text-center">
      <div className="text-sm font-semibold text-ink">{value ?? "—"}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-ink-muted">{label}</div>
    </div>
  );
}

export function MetricsPanel({ metrics }: { metrics: ResponseMetrics }) {
  return (
    <Panel title="Last response metrics">
      <div className="grid grid-cols-3 gap-1.5">
        <Metric value={metrics.latencyMs} label="latency ms" />
        <Metric value={metrics.inputTokens} label="input tok" />
        <Metric value={metrics.outputTokens} label="output tok" />
      </div>
    </Panel>
  );
}
