import type { PropsWithChildren, ReactNode } from "react";

function isUsableNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatBytes(bytes?: number | null): string {
  if (!isUsableNumber(bytes)) return "Tidak tersedia";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, bytes);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? size.toFixed(0) : size.toFixed(2)} ${units[unit]}`;
}

export function formatPercent(value?: number | null): string {
  return isUsableNumber(value) ? `${value.toFixed(1)}%` : "Tidak tersedia";
}

export function percentOf(used?: number | null, total?: number | null): number | undefined {
  if (!isUsableNumber(used) || !isUsableNumber(total) || total <= 0) return undefined;
  return (used / total) * 100;
}

export function Panel({
  title,
  tag,
  accent = "mint",
  className = "",
  children,
}: PropsWithChildren<{
  title?: string;
  tag?: ReactNode;
  accent?: "mint" | "blue" | "amber";
  className?: string;
}>) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-header">
          <h2 className={`eyebrow ${accent}`}>{title}</h2>
          {tag && <span className={`tag ${accent}`}>{tag}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function ProgressBar({
  value,
  accent = "blue",
}: {
  value?: number | null;
  accent?: "mint" | "blue" | "amber";
}) {
  const safeValue = isUsableNumber(value) ? value : 0;
  return (
    <div className="progress">
      <span className={accent} style={{ width: `${Math.min(100, Math.max(0, safeValue))}%` }} />
    </div>
  );
}

export function Sparkline({
  values,
  accent = "mint",
}: {
  values: number[];
  accent?: "mint" | "blue" | "amber";
}) {
  const safe = values.length ? values : [0, 0];
  const max = Math.max(...safe, 1);
  const points = safe
    .map((value, index) => {
      const x = (index / Math.max(safe.length - 1, 1)) * 100;
      const y = 34 - (value / max) * 30;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg className={`sparkline ${accent}`} viewBox="0 0 100 38" preserveAspectRatio="none">
      <polyline points={points} />
    </svg>
  );
}

export function EmptyState({ children }: PropsWithChildren) {
  return <div className="empty-state">{children}</div>;
}

export function ErrorBanner({ message }: { message?: string }) {
  return message ? <div className="error-banner">{message}</div> : null;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  alternateLabel,
  onAlternate,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  alternateLabel?: string;
  onAlternate?: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button className="button ghost" onClick={onCancel}>
            Batal
          </button>
          {alternateLabel && onAlternate && (
            <button className="button ghost" onClick={onAlternate}>
              {alternateLabel}
            </button>
          )}
          <button className="button danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button onClick={onClose} aria-label="Tutup">
        x
      </button>
    </div>
  );
}
