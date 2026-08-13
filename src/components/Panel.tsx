import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, action, children, className = "" }: PanelProps) {
  return (
    <section className={`rounded-lg border border-border bg-surface p-4 shadow-sm ${className}`}>
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
