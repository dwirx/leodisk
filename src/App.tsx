import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  formatBytes,
  formatPercent,
  Panel,
  percentOf,
  ProgressBar,
  Sparkline,
  Toast,
} from "./components";
import type {
  ActionReport,
  AppSizeMeasurement,
  CleanupItem,
  CleanupReport,
  DiskScanProgress,
  DiskScanResult,
  DiskFolder,
  InstalledApp,
  ScanJob,
  StorageVolume,
  StartupItem,
  SystemSnapshot,
  Tab,
} from "./types";
import "./App.css";

const tabs: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "clean", label: "Bersihkan", icon: "CL" },
  { id: "purge", label: "Purge", icon: "PG" },
  { id: "apps", label: "Aplikasi", icon: "AP" },
  { id: "optimize", label: "Optimalkan", icon: "OP" },
  { id: "analyze", label: "Analisis", icon: "AN" },
  { id: "performance", label: "Performa", icon: "PF" },
  { id: "status", label: "Status", icon: "ST" },
];

function messageOf(error: unknown): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (typeof error === "object" && error && "message" in error) {
    const message = String(error.message).trim();
    if ("code" in error) {
      const code = String(error.code).trim();
      return code ? `${message} (${code})` : message;
    }
    return message || "Operasi gagal. Coba kembali.";
  }
  return "Operasi gagal. Coba kembali.";
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { message?: string }> {
  state: { message?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { message: messageOf(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("LeoDisk UI error", error, info.componentStack);
  }

  render() {
    if (this.state.message) {
      return (
        <main className="app-shell">
          <div className="workspace">
            <Panel title="APLIKASI BERHENTI MERESPONS" accent="amber">
              <ErrorBanner message={this.state.message} />
              <EmptyState>Muat ulang LeoDisk. Jika masalah berulang, catat langkah terakhir sebelum error muncul.</EmptyState>
            </Panel>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

function uptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  return `${days} hari ${hours} jam`;
}

function treemapLayout(folders: DiskScanResult["folders"]) {
  let x = 0;
  let y = 0;
  let width = 100;
  let height = 100;
  let remaining = folders.reduce((sum, folder) => sum + folder.sizeBytes, 0);
  return folders.slice(0, 14).map((folder, index) => {
    const ratio = remaining ? folder.sizeBytes / remaining : 1;
    const vertical = width >= height;
    const slice = (vertical ? width : height) * ratio;
    const rect = vertical
      ? { left: x, top: y, width: Math.min(width, slice), height }
      : { left: x, top: y, width, height: Math.min(height, slice) };
    if (vertical) {
      x += rect.width;
      width -= rect.width;
    } else {
      y += rect.height;
      height -= rect.height;
    }
    remaining -= folder.sizeBytes;
    return { folder, index, ...rect };
  });
}

function useSystemSnapshot(active: boolean) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot>();
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [networkHistory, setNetworkHistory] = useState<number[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const load = async () => {
      try {
        const data = await invoke<SystemSnapshot>("get_system_snapshot");
        if (!mounted) return;
        setSnapshot(data);
        setError(undefined);
        setCpuHistory((history) => [...history.slice(-25), data.cpuPercent ?? 0]);
        setNetworkHistory((history) => [...history.slice(-25), data.networkDownPerSec ?? 0]);
      } catch (requestError) {
        if (mounted) setError(messageOf(requestError));
      }
    };
    void load();
    const timer = window.setInterval(load, 1000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [active]);

  return { snapshot, cpuHistory, networkHistory, error };
}

function StatusPage({
  active,
  latestCleanup,
}: {
  active: boolean;
  latestCleanup?: CleanupReport;
}) {
  const { snapshot, cpuHistory, networkHistory, error } = useSystemSnapshot(active);
  const memoryPercent = percentOf(snapshot?.memoryUsed, snapshot?.memoryTotal);
  const diskPercent = percentOf(snapshot?.diskUsed, snapshot?.diskTotal);

  const health = latestCleanup
    ? latestCleanup.totalBytes === 0
      ? { score: "100", text: "Bersih" }
      : latestCleanup.totalBytes < 1024 * 1024 * 500
        ? { score: "86", text: "Cukup baik" }
        : { score: "68", text: "Perlu dibersihkan" }
    : { score: "--", text: "Belum dipindai" };

  return (
    <>
      <ErrorBanner message={error} />
      <div className="status-grid">
        <Panel title="KESEHATAN" accent="mint" className="health-card" tag={snapshot?.computerName}>
          <div className="health-score">
            {health.score}
            <small>{health.text}</small>
          </div>
          <p>
            {latestCleanup
              ? `${formatBytes(latestCleanup.totalBytes)} cache aman ditemukan`
              : "Jalankan pemindaian pada tab Bersihkan"}
          </p>
          <footer>{snapshot ? `Aktif ${uptime(snapshot.uptimeSeconds)} - ${snapshot.osLabel}` : "Mengambil status..."}</footer>
        </Panel>
        <Panel title="CPU" accent="mint" tag={snapshot ? formatPercent(snapshot.cpuPercent) : "--"}>
          <div className="metric">{formatPercent(snapshot?.cpuPercent)}</div>
          <Sparkline values={cpuHistory} />
          <p className="muted">Pemakaian prosesor saat ini</p>
        </Panel>
        <Panel title="MEMORI" accent="amber">
          <div className="metric">{snapshot ? formatPercent(memoryPercent) : "--"}</div>
          <ProgressBar value={memoryPercent} accent="amber" />
          <p className="muted">
            {snapshot ? `${formatBytes(snapshot.memoryUsed)} / ${formatBytes(snapshot.memoryTotal)}` : "Memuat..."}
          </p>
        </Panel>
        <Panel title="GPU" accent="amber">
          <div className="metric">{formatPercent(snapshot?.gpuPercent)}</div>
          <p className="muted">
            {snapshot?.gpuPercent == null
              ? "Counter GPU tidak tersedia"
              : "Utilisasi GPU Windows"}
          </p>
        </Panel>
        <Panel title="DISK" accent="blue" className="wide-card">
          <div className="metric">{snapshot ? formatBytes(snapshot.diskTotal - snapshot.diskUsed) : "--"} <small>tersedia</small></div>
          <ProgressBar value={diskPercent} accent="blue" />
          <p className="muted">
            {snapshot
              ? `${formatBytes(snapshot.diskUsed)} terpakai - baca ${formatBytes(snapshot.diskReadPerSec)}/s - tulis ${formatBytes(snapshot.diskWritePerSec)}/s`
              : "Memuat disk..."}
          </p>
        </Panel>
        <Panel title="JARINGAN" accent="blue" className="wide-card">
          <div className="metric">{formatBytes(snapshot?.networkDownPerSec)}<small>/s</small></div>
          <Sparkline values={networkHistory} accent="blue" />
          <p className="muted">
            turun {formatBytes(snapshot?.networkDownPerSec)}/s - naik {formatBytes(snapshot?.networkUpPerSec)}/s
          </p>
        </Panel>
        <Panel title="BATERAI" accent="mint" className="battery-card">
          {snapshot?.battery ? (
            <>
              <div className="metric">{snapshot.battery.percent}%</div>
              <ProgressBar value={snapshot.battery.percent} accent="mint" />
              <p className="muted">{snapshot.battery.charging ? "Sedang mengisi daya" : "Menggunakan baterai"}</p>
            </>
          ) : (
            <EmptyState>Tidak ada baterai terdeteksi</EmptyState>
          )}
        </Panel>
      </div>
      <Panel className="process-panel">
        <div className="table-head process-row">
          <span>NAMA PROSES</span>
          <span>PID</span>
          <span>CPU</span>
          <span>MEMORI</span>
        </div>
        {snapshot?.processes.map((process) => (
          <div className="process-row" key={process.pid}>
            <strong>{process.name}</strong>
            <span className="mono">{process.pid}</span>
            <span className="mono">{formatPercent(process.cpuPercent)}</span>
            <span className="mono">{formatBytes(process.memoryBytes)}</span>
          </div>
        ))}
        {!snapshot && <EmptyState>Menunggu snapshot sistem...</EmptyState>}
      </Panel>
    </>
  );
}

function PerformancePage({ active }: { active: boolean }) {
  const { snapshot, cpuHistory, networkHistory, error } = useSystemSnapshot(active);
  const memoryPercent = percentOf(snapshot?.memoryUsed, snapshot?.memoryTotal);
  const diskPercent = percentOf(snapshot?.diskUsed, snapshot?.diskTotal);
  const availableDisk = snapshot ? snapshot.diskTotal - snapshot.diskUsed : undefined;
  const alerts = [
    snapshot && snapshot.cpuPercent >= 85 ? "CPU sedang tinggi" : undefined,
    memoryPercent !== undefined && memoryPercent >= 85 ? "Memori hampir penuh" : undefined,
    diskPercent !== undefined && diskPercent >= 90 ? "Disk hampir penuh" : undefined,
    snapshot?.diskReadPerSec == null && snapshot?.diskWritePerSec == null ? "Counter I/O disk tidak tersedia" : undefined,
  ].filter((alert): alert is string => Boolean(alert));

  return (
    <div className="feature-page performance-page">
      <div className="page-title">
        <div>
          <h1>Analisis performa</h1>
          <p>Pantau pemakaian sistem real-time sebelum menjalankan scan atau pembersihan besar.</p>
        </div>
        <span className="tag blue">{snapshot ? snapshot.computerName : "Memuat"}</span>
      </div>
      <ErrorBanner message={error} />
      <div className="summary-cards">
        <Panel title="CPU" accent="mint" tag={formatPercent(snapshot?.cpuPercent)}>
          <div className="metric">{formatPercent(snapshot?.cpuPercent)}</div>
          <Sparkline values={cpuHistory} />
        </Panel>
        <Panel title="MEMORI" accent="amber" tag={formatPercent(memoryPercent)}>
          <div className="metric">{formatBytes(snapshot?.memoryUsed)}</div>
          <ProgressBar value={memoryPercent} accent="amber" />
          <p className="muted">Total {formatBytes(snapshot?.memoryTotal)}</p>
        </Panel>
        <Panel title="DISK" accent="blue" tag={`${formatBytes(availableDisk)} kosong`}>
          <div className="metric">{formatPercent(diskPercent)}</div>
          <ProgressBar value={diskPercent} accent="blue" />
          <p className="muted">
            baca {formatBytes(snapshot?.diskReadPerSec)}/s - tulis {formatBytes(snapshot?.diskWritePerSec)}/s
          </p>
        </Panel>
      </div>
      <div className="summary-cards">
        <Panel title="JARINGAN" accent="blue">
          <div className="metric">{formatBytes(snapshot?.networkDownPerSec)}<small>/s</small></div>
          <Sparkline values={networkHistory} accent="blue" />
          <p className="muted">naik {formatBytes(snapshot?.networkUpPerSec)}/s</p>
        </Panel>
        <Panel title="GPU" accent="amber">
          <div className="metric">{formatPercent(snapshot?.gpuPercent)}</div>
          <p className="muted">{snapshot?.gpuPercent == null ? "Counter GPU tidak tersedia" : "Utilisasi GPU Windows"}</p>
        </Panel>
        <Panel title="BATERAI" accent="mint">
          {snapshot?.battery ? (
            <>
              <div className="metric">{snapshot.battery.percent}%</div>
              <ProgressBar value={snapshot.battery.percent} accent="mint" />
              <p className="muted">{snapshot.battery.charging ? "Sedang mengisi daya" : "Menggunakan baterai"}</p>
            </>
          ) : (
            <EmptyState>Tidak ada baterai terdeteksi</EmptyState>
          )}
        </Panel>
      </div>
      <Panel title="INDIKATOR MASALAH" accent={alerts.length ? "amber" : "mint"} tag={`${alerts.length} catatan`}>
        {alerts.length ? (
          <div className="category-grid">
            {alerts.map((alert) => (
              <div className="category-card amber" key={alert}>
                <span>{alert}</span>
                <small>Periksa proses dan kapasitas sebelum menjalankan tugas berat.</small>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>Tidak ada indikator performa yang perlu perhatian.</EmptyState>
        )}
      </Panel>
      <Panel className="process-panel" title="PROSES TERATAS" accent="blue">
        <div className="table-head process-row">
          <span>NAMA PROSES</span>
          <span>PID</span>
          <span>CPU</span>
          <span>MEMORI</span>
        </div>
        {snapshot?.processes.map((process) => (
          <div className="process-row" key={process.pid}>
            <strong>{process.name}</strong>
            <span className="mono">{process.pid}</span>
            <span className="mono">{formatPercent(process.cpuPercent)}</span>
            <span className="mono">{formatBytes(process.memoryBytes)}</span>
          </div>
        ))}
        {!snapshot && <EmptyState>Menunggu snapshot sistem...</EmptyState>}
      </Panel>
    </div>
  );
}

function CleanupTable({
  report,
  selected,
  onToggle,
  onOpen,
}: {
  report: CleanupReport;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="cleanup-list">
      {report.items.map((item) => (
        <div className="cleanup-row" key={item.id}>
          <input
            aria-label={`Pilih ${item.category}`}
            type="checkbox"
            checked={selected.has(item.id)}
            onChange={() => onToggle(item.id)}
          />
          <span className="cleanup-name">
            <strong>{item.category}</strong>
            <small>{item.path}</small>
            <small className={`safety ${item.safeToDelete ? "safe" : "review"}`}>
              {item.safetyLabel} - {item.safetyNote}
            </small>
          </span>
          <span className="mono">{item.fileCount} file</span>
          <span className="mono">{formatBytes(item.sizeBytes)}</span>
          <button className="text-action" onClick={() => onOpen(item.id)}>Buka lokasi</button>
        </div>
      ))}
    </div>
  );
}

function cleanupSummary(report: CleanupReport) {
  return report.summary ?? {
    checked: report.items.length,
    total: report.items.length,
    found: report.items.length,
    notFound: 0,
    accessLimited: report.items.filter((item) => item.skippedCount > 0).length,
    skipped: report.skippedCount,
    advisoryCount: report.advisories?.length ?? 0,
    totalJunkBytes: report.totalBytes,
    cleanableBytes: report.items.filter((item) => item.safeToDelete).reduce((sum, item) => sum + item.sizeBytes, 0),
    cleanableItems: report.items.filter((item) => item.safeToDelete).length,
    reviewBytes: report.items.filter((item) => !item.safeToDelete).reduce((sum, item) => sum + item.sizeBytes, 0),
    reviewItems: report.items.filter((item) => !item.safeToDelete).length,
    manualBytes: 0,
    manualItems: 0,
    advisoryBytes: report.advisories?.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0,
    advisoryItems: report.advisories?.length ?? 0,
  };
}

function decisionOf(item: CleanupItem) {
  return item.decision ?? (item.safeToDelete ? "clean" : "review");
}

function riskLabel(value?: string) {
  if (value === "high") return "Risiko Tinggi";
  if (value === "medium") return "Risiko Sedang";
  return "Risiko Rendah";
}

function decisionLabel(value?: string) {
  if (value === "manual") return "Manual Saja";
  if (value === "review") return "Review Dulu";
  if (value === "advisory") return "Advisory";
  return "Siap Dibersihkan";
}

function cleanupIconCode(item: CleanupItem) {
  const source = `${item.icon ?? ""} ${item.name ?? ""} ${item.category}`.toLowerCase();
  if (source.includes("windows")) return "WN";
  if (source.includes("python") || source.includes("pip")) return "PY";
  if (source.includes("cargo") || source.includes("rust")) return "RS";
  if (source.includes("npm") || source.includes("yarn") || source.includes("pnpm") || source.includes("bun")) return "PK";
  if (source.includes("browser") || source.includes("chrome") || source.includes("edge") || source.includes("firefox") || source.includes("brave")) return "BR";
  if (source.includes("download")) return "DL";
  if (source.includes("gpu") || source.includes("shader") || source.includes("nvidia") || source.includes("amd")) return "GP";
  if (source.includes("trash") || source.includes("recycle")) return "TR";
  if (source.includes("app") || source.includes("discord") || source.includes("slack")) return "AP";
  if (source.includes("manual") || source.includes("installer")) return "MN";
  if (source.includes("advisory") || source.includes("memory") || source.includes("power")) return "AD";
  return (item.category || "IT").slice(0, 2).toUpperCase();
}

function ButtonIcon({ code }: { code: string }) {
  return <span className="button-icon" aria-hidden="true">{code}</span>;
}

function statusText(report: CleanupReport) {
  const summary = cleanupSummary(report);
  const level = summary.totalJunkBytes >= 10 * 1024 * 1024 * 1024 ? "Kritis" : summary.totalJunkBytes ? "Perlu Perhatian" : "Bersih";
  return `${level}. ${formatBytes(summary.totalJunkBytes)} junk ditemukan dan ${formatBytes(summary.cleanableBytes)} siap dibersihkan sekarang.`;
}

function CleanPage({
  onReport,
  notify,
}: {
  onReport: (report: CleanupReport) => void;
  notify: (message: string) => void;
}) {
  const [report, setReport] = useState<CleanupReport>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"all" | "low" | "medium" | "high">("all");
  const [decisionFilter, setDecisionFilter] = useState<"all" | "clean" | "review" | "manual" | "advisory">("all");
  const [sizeFilter, setSizeFilter] = useState<0 | 100 | 500 | 1024>(0);
  const [sort, setSort] = useState<"size" | "name" | "priority">("size");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (report) onReport(report);
  }, [onReport, report]);

  const scan = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await invoke<CleanupReport>("scan_deep_cleanup");
      setReport(result);
      setSelected(new Set(result.items.filter((item) => decisionOf(item) === "clean").map((item) => item.id)));
      setReviewed(new Set());
      setExpanded(new Set());
      setVisibleLimit(80);
    } catch (scanError) {
      setError(messageOf(scanError));
    } finally {
      setLoading(false);
    }
  };

  const remove = async (permanent: boolean) => {
    setConfirming(false);
    try {
      const result = await invoke<ActionReport>("delete_cleanup_items", {
        itemIds: [...selected],
        permanent,
      });
      notify(result.message);
      setReport((current) => {
        if (!current) return current;
        const removed = new Set(selected);
        const nextItems = current.items.filter((item) => !removed.has(item.id));
        const nextReport = {
          ...current,
          items: nextItems,
          totalBytes: nextItems.reduce((sum, item) => sum + item.sizeBytes, 0),
          totalFiles: nextItems.reduce((sum, item) => sum + item.fileCount, 0),
          skippedCount: nextItems.reduce((sum, item) => sum + item.skippedCount, 0),
          summary: undefined,
          categoryTotals: undefined,
        };
        return nextReport;
      });
      setSelected(new Set());
    } catch (removeError) {
      setError(messageOf(removeError));
    }
  };
  const openLocation = async (itemId: string) => {
    try {
      await invoke<ActionReport>("open_scanned_location", { itemId });
    } catch (openError) {
      setError(messageOf(openError));
    }
  };
  const exportReport = async (command: "export_cleanup_report" | "export_cleanup_metafile" | "export_cleanup_detail", openFile = false) => {
    setError(undefined);
    try {
      const result = await invoke<ActionReport>(command);
      notify(`Export dibuat: ${result.message}`);
      if (openFile) await openPath(result.message);
    } catch (exportError) {
      setError(messageOf(exportError));
    }
  };

  useEffect(() => {
    setVisibleLimit(80);
  }, [query, riskFilter, decisionFilter, sizeFilter, sort]);

  const summary = useMemo(() => report ? cleanupSummary(report) : undefined, [report]);
  const allItems = useMemo(() => report ? [...report.items, ...(report.advisories ?? [])] : [], [report]);
  const filtered = useMemo(() => allItems
    .filter((item) => {
      const haystack = `${item.name ?? item.category} ${item.path} ${item.category} ${item.group ?? ""}`.toLowerCase();
      const minBytes = sizeFilter * 1024 * 1024;
      return haystack.includes(query.toLowerCase())
        && (riskFilter === "all" || item.riskLevel === riskFilter)
        && (decisionFilter === "all" || decisionOf(item) === decisionFilter)
        && item.sizeBytes >= minBytes;
    })
    .sort((a, b) => {
      if (sort === "name") return (a.name ?? a.category).localeCompare(b.name ?? b.category);
      if (sort === "priority") return (b.priority ?? 0) - (a.priority ?? 0) || b.sizeBytes - a.sizeBytes;
      return b.sizeBytes - a.sizeBytes;
    }), [allItems, decisionFilter, query, riskFilter, sizeFilter, sort]);
  const visibleItems = filtered.slice(0, visibleLimit);
  const cleanTop = useMemo(() => report?.items.filter((item) => decisionOf(item) === "clean").slice(0, 5) ?? [], [report]);
  const reviewTop = useMemo(() => report?.items.filter((item) => decisionOf(item) === "review").slice(0, 5) ?? [], [report]);
  const manualTop = useMemo(() => report?.items.filter((item) => decisionOf(item) === "manual").slice(0, 3) ?? [], [report]);
  const cleanIds = useMemo(() => report?.items.filter((item) => decisionOf(item) === "clean").map((item) => item.id) ?? [], [report]);
  const filteredCleanIds = useMemo(() => filtered.filter((item) => decisionOf(item) === "clean").map((item) => item.id), [filtered]);
  const selectIds = (ids: string[]) => {
    setSelected((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.add(id));
      return next;
    });
  };
  const markReviewed = (itemId: string) => {
    setReviewed((current) => new Set(current).add(itemId));
  };
  const toggleExpanded = (itemId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  };

  return (
    <div className="feature-page clean-deep-page">
      <div className="page-title">
        <div>
          <h1>Deep Cleanup Report</h1>
          <p>{report ? statusText(report) : "Scan cache, dev artifact, advisory disk hog, dan target manual dalam satu laporan audit."}</p>
        </div>
        <div className="row-buttons">
          {report && <button className="button ghost" onClick={() => void exportReport("export_cleanup_detail", true)}><ButtonIcon code="OP" />Buka Analyzer</button>}
          <button className="button primary" disabled={loading} onClick={scan}>
            <ButtonIcon code="SC" />
            {loading ? "Memindai..." : "Pindai Deep Cleanup"}
          </button>
        </div>
      </div>
      <ErrorBanner message={error} />
      {!report && <Panel><EmptyState>Mulai pemindaian untuk menemukan cache browser/app, dev cache, shader cache, Downloads review, manual-only target, dan advisory disk hog.</EmptyState></Panel>}
      {report && (
        <>
          <Panel className="critical-panel" title="STATUS" accent={summary?.cleanableBytes ? "amber" : "mint"} tag={report.scanFinishedAt ? `Scan selesai: ${report.scanFinishedAt}` : "Selesai"}>
            <div className="critical-copy">{statusText(report)}</div>
            <div className="scan-metrics">
              <span><strong>{summary?.checked}</strong>Diperiksa</span>
              <span><strong>{summary?.found}</strong>Ditemukan</span>
              <span><strong>{summary?.notFound}</strong>Tidak Ada</span>
              <span><strong>{summary?.accessLimited}</strong>Akses Terbatas</span>
              <span><strong>{summary?.skipped}</strong>Item Terlewati</span>
              <span><strong>{summary?.advisoryCount}</strong>Advisory</span>
            </div>
            <div className="panel-actions">
              <span>Export audit tanpa scan ulang</span>
              <button className="button ghost compact" onClick={() => void exportReport("export_cleanup_metafile")}><ButtonIcon code="MF" />Export Metafile</button>
              <button className="button ghost compact" onClick={() => void exportReport("export_cleanup_report")}><ButtonIcon code="JS" />Export Cleanup Report</button>
              <button className="button ghost compact" onClick={() => void exportReport("export_cleanup_detail")}><ButtonIcon code="HT" />Export Laporan Detail</button>
            </div>
          </Panel>
          <div className="summary-cards cleanup-scorecards">
            <Panel title="TOTAL SAMPAH" accent="amber"><div className="metric">{formatBytes(summary?.totalJunkBytes)}</div><p className="muted">{report.totalFiles} file</p></Panel>
            <Panel title="SIAP DIBERSIHKAN" accent="mint"><div className="metric">{formatBytes(summary?.cleanableBytes)}</div><p className="muted">{summary?.cleanableItems} folder</p></Panel>
            <Panel title="PERLU REVIEW" accent="blue"><div className="metric">{summary?.reviewItems}</div><p className="muted">{formatBytes(summary?.reviewBytes)}</p></Panel>
            <Panel title="MANUAL / TERTAHAN" accent="amber"><div className="metric">{summary?.manualItems}</div><p className="muted">{formatBytes(summary?.manualBytes)}</p></Panel>
            <Panel title="DISK HOG ADVISORY" accent="blue"><div className="metric">{formatBytes(summary?.advisoryBytes)}</div><p className="muted">{summary?.advisoryItems} temuan</p></Panel>
          </div>
          <div className="cleanup-priority-grid">
            <Panel title="PRIORITAS AMAN TERBESAR" accent="mint" tag={`${cleanTop.length} kandidat teratas`}>
              <div className="priority-list">
                {cleanTop.map((item, index) => (
                  <article className="priority-item clean" key={item.id}>
                    <span className="rank-pill">#{index + 1}</span>
                    <span className={`cleanup-icon ${decisionOf(item)}`}>{cleanupIconCode(item)}</span>
                    <strong>{item.name ?? item.category}</strong>
                    <small>{item.safetyNote}</small>
                    <b>{formatBytes(item.sizeBytes)}</b>
                    <div className="priority-actions">
                      <button className="button ghost compact" onClick={() => selectIds([item.id])}><ButtonIcon code="+" />Pilih</button>
                      <button className="text-action" onClick={() => void openLocation(item.id)}>Buka Folder</button>
                    </div>
                  </article>
                ))}
                {!cleanTop.length && <EmptyState>Tidak ada target aman.</EmptyState>}
              </div>
            </Panel>
            <Panel title="BUTUH REVIEW MANUAL" accent="blue" tag={`${reviewTop.length} target`}>
              <div className="priority-list">
                {reviewTop.map((item, index) => (
                  <article className="priority-item review" key={item.id}>
                    <span className="rank-pill">#{index + 1}</span>
                    <span className={`cleanup-icon ${decisionOf(item)}`}>{cleanupIconCode(item)}</span>
                    <strong>{item.name ?? item.category}</strong>
                    <small>{item.safetyNote}</small>
                    <b>{formatBytes(item.sizeBytes)}</b>
                    <div className="priority-actions">
                      <button className="text-action" onClick={() => void openLocation(item.id)}>Buka Folder</button>
                    </div>
                  </article>
                ))}
                {!reviewTop.length && <EmptyState>Tidak ada target review.</EmptyState>}
              </div>
            </Panel>
            <Panel title="MANUAL ACTION ONLY" accent="amber" tag={`${manualTop.length} target`}>
              <div className="priority-list">
                {manualTop.map((item, index) => (
                  <article className="priority-item manual" key={item.id}>
                    <span className="rank-pill">#{index + 1}</span>
                    <span className={`cleanup-icon ${decisionOf(item)}`}>{cleanupIconCode(item)}</span>
                    <strong>{item.name ?? item.category}</strong>
                    <small>{item.safetyNote}</small>
                    <b>{formatBytes(item.sizeBytes)}</b>
                    <div className="priority-actions">
                      <button className="text-action" onClick={() => void openLocation(item.id)}>Buka Folder</button>
                    </div>
                  </article>
                ))}
                {!manualTop.length && <EmptyState>Tidak ada target manual.</EmptyState>}
              </div>
            </Panel>
          </div>
          <Panel title="PENYEBAB DISK PENUH LAINNYA" accent="amber" tag={`${report.advisories?.length ?? 0} advisory non-auto-clean`}>
            <div className="advisory-list">
              {(report.advisories ?? []).map((item) => (
                <article className={`advisory-item ${item.riskLevel ?? "medium"}`} key={item.id}>
                  <span className={`cleanup-icon ${decisionOf(item)}`}>{cleanupIconCode(item)}</span>
                  <span>{riskLabel(item.riskLevel)}</span>
                  <strong>{item.name ?? item.category}</strong>
                  <small>{item.safetyNote}</small>
                  <p>{item.recommendation}</p>
                  <code>{item.path}</code>
                  <b>{formatBytes(item.sizeBytes)}</b>
                </article>
              ))}
              {!report.advisories?.length && <EmptyState>Tidak ada advisory disk hog.</EmptyState>}
            </div>
          </Panel>
          <Panel title="HASIL PEMINDAIAN" accent="mint" tag={`Menampilkan ${visibleItems.length} / ${filtered.length} item`}>
            <div className="cleanup-filterbar">
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nama folder, path, atau kategori..." />
              <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as typeof riskFilter)}>
                <option value="all">Semua Risiko</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as typeof decisionFilter)}>
                <option value="all">Semua Keputusan</option>
                <option value="clean">Clean</option>
                <option value="review">Review</option>
                <option value="manual">Manual</option>
                <option value="advisory">Advisory</option>
              </select>
              <select value={sizeFilter} onChange={(event) => setSizeFilter(Number(event.target.value) as typeof sizeFilter)}>
                <option value={0}>Semua Ukuran</option>
                <option value={100}>&gt;= 100 MB</option>
                <option value={500}>&gt;= 500 MB</option>
                <option value={1024}>&gt;= 1 GB</option>
              </select>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                <option value="size">Ukuran</option>
                <option value="name">Nama</option>
                <option value="priority">Rekomendasi</option>
              </select>
            </div>
            <p className="protected-note">Centang item berlabel Siap Dibersihkan untuk masuk batch clean. Item lain tetap ditahan sampai review manual.</p>
            <div className="deep-cleanup-list">
              {visibleItems.map((item) => {
                const decision = decisionOf(item);
                const selectable = decision === "clean";
                const isReviewed = reviewed.has(item.id);
                const isExpanded = expanded.has(item.id);
                return (
                  <article className={`deep-cleanup-row ${decision} ${isReviewed ? "reviewed" : ""}`} key={item.id}>
                    <input
                      aria-label={`Pilih ${item.name ?? item.category}`}
                      type="checkbox"
                      disabled={!selectable}
                      checked={selected.has(item.id)}
                      onChange={() => {
                        if (!selectable) return;
                        setSelected((current) => {
                          const next = new Set(current);
                          next.has(item.id) ? next.delete(item.id) : next.add(item.id);
                          return next;
                        });
                      }}
                    />
                    <span className={`cleanup-icon ${decision}`}>{cleanupIconCode(item)}</span>
                    <span className="cleanup-name">
                      <strong>{item.name ?? item.category}</strong>
                      <small>{item.category} - {decisionLabel(decision)} - {riskLabel(item.riskLevel)} - {item.kind ?? "folder"}</small>
                      <small className={`safety ${selectable ? "safe" : "review"}`}>{item.safetyLabel} - {item.safetyNote}</small>
                      {item.blockedReason && <small className="safety review">{item.blockedReason}</small>}
                      {isReviewed && <small className="safety safe">Sudah dicek manual</small>}
                    </span>
                    <span className="mono">{formatBytes(item.sizeBytes)}</span>
                    <span className="mono">{item.fileCount} file</span>
                    <div className="row-actions">
                      <button className="text-action" onClick={() => toggleExpanded(item.id)}>{isExpanded ? "Tutup" : "Detail"}</button>
                      {!selectable && <button className="text-action" onClick={() => markReviewed(item.id)}>Cek</button>}
                      <button className="text-action" onClick={() => void openLocation(item.id)}>Buka</button>
                    </div>
                    {isExpanded && (
                      <div className="cleanup-row-detail">
                        <span><strong>Path</strong><code>{item.path}</code></span>
                        <span><strong>Rekomendasi</strong>{item.recommendation ?? item.safetyNote}</span>
                        <span><strong>Status</strong>{item.status ?? decision} - priority {item.priority ?? 0}</span>
                        <span><strong>Audit</strong>{item.fileCount} file, {item.skippedCount} terlewati, {formatBytes(item.sizeBytes)}</span>
                      </div>
                    )}
                  </article>
                );
              })}
              {!filtered.length && <EmptyState>Tidak ada item sesuai filter.</EmptyState>}
              {visibleItems.length < filtered.length && (
                <button className="button ghost load-more" onClick={() => setVisibleLimit((current) => current + 80)}>
                  <ButtonIcon code="++" />
                  Tampilkan 80 lagi
                </button>
              )}
            </div>
            <div className="panel-actions">
              <span>{selected.size} clean dipilih - {reviewed.size} sudah dicek</span>
              <button className="button ghost compact" disabled={!cleanIds.length} onClick={() => selectIds(cleanIds)}><ButtonIcon code="++" />Pilih semua Clean</button>
              <button className="button ghost compact" disabled={!filteredCleanIds.length} onClick={() => selectIds(filteredCleanIds)}><ButtonIcon code="+F" />Pilih Clean terfilter</button>
              <button className="button ghost compact" disabled={!selected.size} onClick={() => setSelected(new Set())}><ButtonIcon code="--" />Unselect all</button>
              <button className="button danger" disabled={!selected.size} onClick={() => setConfirming(true)}>
                <ButtonIcon code="RM" />
                Hapus item terpilih
              </button>
            </div>
          </Panel>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Bersihkan item terpilih?"
          description="Hanya item berkeputusan Clean yang masuk batch. Pilih Recycle Bin untuk dapat memulihkan file, atau Hapus permanen jika Anda yakin."
          confirmLabel="Hapus permanen"
          onCancel={() => setConfirming(false)}
          alternateLabel="Ke Recycle Bin"
          onAlternate={() => void remove(false)}
          onConfirm={() => void remove(true)}
        />
      )}
    </div>
  );
}

function PurgePage({ notify }: { notify: (message: string) => void }) {
  const [report, setReport] = useState<CleanupReport>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<"artifacts" | "installers" | "folder">();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const applyReport = (result: CleanupReport) => {
    setReport(result);
    setSelected(new Set());
  };

  const scanArtifacts = async (paths?: string[]) => {
    setLoading(paths?.length ? "folder" : "artifacts");
    setError(undefined);
    try {
      const result = await invoke<CleanupReport>("scan_project_artifacts", { paths });
      applyReport(result);
    } catch (scanError) {
      setError(messageOf(scanError));
    } finally {
      setLoading(undefined);
    }
  };

  const scanInstallers = async () => {
    setLoading("installers");
    setError(undefined);
    try {
      const result = await invoke<CleanupReport>("scan_installers");
      applyReport(result);
    } catch (scanError) {
      setError(messageOf(scanError));
    } finally {
      setLoading(undefined);
    }
  };

  const chooseFolder = async () => {
    try {
      const chosen = await open({ directory: true, multiple: false, title: "Pilih folder proyek" });
      if (typeof chosen === "string") await scanArtifacts([chosen]);
    } catch (chooseError) {
      setError(messageOf(chooseError));
    }
  };

  const remove = async (permanent: boolean) => {
    setConfirming(false);
    setError(undefined);
    try {
      const result = await invoke<ActionReport>("delete_cleanup_items", {
        itemIds: [...selected],
        permanent,
      });
      notify(result.message);
      setReport((current) => current && ({
        ...current,
        items: current.items.filter((item) => !selected.has(item.id)),
      }));
      setSelected(new Set());
    } catch (removeError) {
      setError(messageOf(removeError));
    }
  };

  const openLocation = async (itemId: string) => {
    setError(undefined);
    try {
      const result = await invoke<ActionReport>("open_scanned_location", { itemId });
      notify(result.message);
    } catch (openError) {
      setError(messageOf(openError));
    }
  };

  return (
    <div className="feature-page purge-page">
      <div className="page-title">
        <div>
          <h1>Purge artefak proyek</h1>
          <p>Adaptasi fitur Mole untuk Windows: temukan dependency, build output, cache proyek, virtualenv, dan installer besar.</p>
        </div>
        <div className="row-buttons">
          <button className="button ghost" disabled={!!loading} onClick={() => void chooseFolder()}>
            {loading === "folder" ? "Memindai..." : "Pilih folder"}
          </button>
          <button className="button primary" disabled={!!loading} onClick={() => void scanArtifacts()}>
            {loading === "artifacts" ? "Memindai..." : "Scan artefak"}
          </button>
          <button className="button ghost" disabled={!!loading} onClick={() => void scanInstallers()}>
            {loading === "installers" ? "Memindai..." : "Scan installer"}
          </button>
        </div>
      </div>
      <ErrorBanner message={error} />
      {!report && (
        <Panel>
          <EmptyState>Pilih folder proyek atau scan lokasi umum untuk mencari artefak yang bisa dibuat ulang.</EmptyState>
        </Panel>
      )}
      {report && (
        <>
          <div className="summary-cards">
            <Panel title="POTENSI RUANG" accent="amber"><div className="metric">{formatBytes(report.totalBytes)}</div></Panel>
            <Panel title="ITEM" accent="blue"><div className="metric">{report.items.length}</div></Panel>
            <Panel title="DILEWATI" accent="mint"><div className="metric">{report.skippedCount}</div></Panel>
          </div>
          <Panel title="HASIL PURGE" accent="amber" tag={`${selected.size} dipilih`}>
            {report.items.length ? (
              <CleanupTable
                report={report}
                selected={selected}
                onOpen={(id) => void openLocation(id)}
                onToggle={(id) => {
                  setSelected((current) => {
                    const next = new Set(current);
                    next.has(id) ? next.delete(id) : next.add(id);
                    return next;
                  });
                }}
              />
            ) : (
              <EmptyState>Tidak ditemukan artefak proyek atau installer besar pada lokasi yang dipindai.</EmptyState>
            )}
            <div className="panel-actions">
              <span>{selected.size} item dipilih - semua hasil perlu diperiksa dahulu</span>
              <button className="button danger" disabled={!selected.size} onClick={() => setConfirming(true)}>
                Hapus item dipilih
              </button>
            </div>
          </Panel>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Hapus item purge?"
          description="Artefak proyek dan installer bisa saja masih dibutuhkan. Gunakan Recycle Bin untuk opsi pemulihan, atau hapus permanen hanya bila yakin."
          confirmLabel="Hapus permanen"
          alternateLabel="Ke Recycle Bin"
          onCancel={() => setConfirming(false)}
          onAlternate={() => void remove(false)}
          onConfirm={() => void remove(true)}
        />
      )}
    </div>
  );
}

function AppsPage({ active, notify }: { active: boolean; notify: (message: string) => void }) {
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"name" | "size">("name");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<InstalledApp>();
  const [selectedApp, setSelectedApp] = useState<InstalledApp>();
  const [measurement, setMeasurement] = useState<AppSizeMeasurement>();
  const [measuring, setMeasuring] = useState(false);
  const [remnants, setRemnants] = useState<CleanupReport>();
  const [remnantsLoading, setRemnantsLoading] = useState(false);
  const [selectedRemnants, setSelectedRemnants] = useState<Set<string>>(new Set());
  const [confirmRemnants, setConfirmRemnants] = useState(false);
  const [openingAppId, setOpeningAppId] = useState<string>();
  const [uninstalling, setUninstalling] = useState(false);

  const loadApps = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setApps(await invoke<InstalledApp[]>("list_installed_apps"));
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) return;
    void loadApps();
  }, [active]);

  const filtered = [...apps]
    .filter((app) => `${app.name} ${app.publisher}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => sort === "name"
      ? a.name.localeCompare(b.name)
      : (b.estimatedSizeBytes ?? 0) - (a.estimatedSizeBytes ?? 0));
  const selectApp = (app: InstalledApp) => {
    if (selectedApp?.id !== app.id) {
      setMeasurement(undefined);
      setRemnants(undefined);
      setSelectedRemnants(new Set());
    }
    setSelectedApp(app);
    setError(undefined);
  };
  const uninstall = async () => {
    if (!target) return;
    setUninstalling(true);
    setError(undefined);
    try {
      const result = await invoke<ActionReport>("launch_uninstaller", { appId: target.id });
      notify(result.message);
    } catch (uninstallError) {
      setError(messageOf(uninstallError));
    } finally {
      setUninstalling(false);
      setTarget(undefined);
    }
  };
  const findRemnants = async (app: InstalledApp) => {
    setRemnantsLoading(true);
    setError(undefined);
    try {
      const result = await invoke<CleanupReport>("scan_app_remnants", { appId: app.id });
      setRemnants(result);
      setSelectedRemnants(new Set(result.items.filter((item) => item.safeToDelete).map((item) => item.id)));
    } catch (scanError) {
      setError(messageOf(scanError));
    } finally {
      setRemnantsLoading(false);
    }
  };
  const measureInstallation = async (app: InstalledApp) => {
    setMeasuring(true);
    setError(undefined);
    try {
      setMeasurement(await invoke<AppSizeMeasurement>("measure_app_installation", { appId: app.id }));
    } catch (measureError) {
      setError(messageOf(measureError));
    } finally {
      setMeasuring(false);
    }
  };
  const removeRemnants = async (permanent: boolean) => {
    setConfirmRemnants(false);
    setError(undefined);
    try {
      const result = await invoke<ActionReport>("delete_cleanup_items", {
        itemIds: [...selectedRemnants],
        permanent,
      });
      notify(result.message);
      setRemnants(undefined);
    } catch (removeError) {
      setError(messageOf(removeError));
    }
  };
  const openAppLocation = async (app: InstalledApp) => {
    setOpeningAppId(app.id);
    setError(undefined);
    try {
      const result = await invoke<ActionReport>("open_app_location", { appId: app.id });
      notify(result.message);
    } catch (openError) {
      setError(messageOf(openError));
    } finally {
      setOpeningAppId(undefined);
    }
  };
  const openRemnantLocation = async (itemId: string) => {
    setError(undefined);
    try {
      const result = await invoke<ActionReport>("open_scanned_location", { itemId });
      notify(result.message);
    } catch (openError) {
      setError(messageOf(openError));
    }
  };

  return (
    <div className="feature-page apps-page">
      <div className="apps-toolbar">
        <div className="segment"><button className="selected">Copot pemasangan</button><button disabled>Pembaruan</button></div>
        <div className="sort-actions">
          <button className={sort === "name" ? "selected" : ""} onClick={() => setSort("name")}>Nama</button>
          <button className={sort === "size" ? "selected" : ""} onClick={() => setSort("size")}>Ukuran</button>
          <input className="search" placeholder="Cari aplikasi" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      <ErrorBanner message={error} />
      <div className="apps-layout">
        <section className="apps-list">
          {loading && <EmptyState>Memuat aplikasi terpasang...</EmptyState>}
          {!loading && filtered.map((app) => (
            <button className={`app-card-row ${selectedApp?.id === app.id ? "selected" : ""}`} key={app.id} onClick={() => selectApp(app)}>
              <span className="app-icon">{app.name.charAt(0).toUpperCase()}</span>
              <span className="app-name">
                <strong>{app.name}</strong>
                <small>{app.version || "Versi tidak tersedia"} - {formatBytes(app.estimatedSizeBytes)} - {app.publisher || "Publisher tidak tercantum"}</small>
              </span>
            </button>
          ))}
          {!loading && !filtered.length && (
            <EmptyState>
              <span>Tidak ada aplikasi Win32/MSI yang cocok. Aplikasi Store/MSIX belum didukung.</span>
              {!!error && <button className="button ghost compact" onClick={() => void loadApps()}>Coba lagi</button>}
            </EmptyState>
          )}
        </section>
        <aside className="app-detail panel" aria-label="Detail aplikasi">
          {selectedApp ? (
            <>
              <div className="detail-heading">
                <span className="app-icon">{selectedApp.name.charAt(0).toUpperCase()}</span>
                <div>
                  <h2>{selectedApp.name}</h2>
                  <p>{selectedApp.publisher || "Publisher tidak tercantum"}</p>
                </div>
              </div>
              <dl className="detail-fields">
                <div><dt>Versi</dt><dd>{selectedApp.version || "Tidak tersedia"}</dd></div>
                <div><dt>Estimasi registry</dt><dd>{formatBytes(selectedApp.estimatedSizeBytes)}</dd></div>
                <div><dt>Ukuran folder</dt><dd>{measurement ? formatBytes(measurement.sizeBytes) : "Belum dihitung"}</dd></div>
                <div><dt>Lokasi</dt><dd title={selectedApp.installLocation}>{selectedApp.installLocation || "Tidak tercantum"}</dd></div>
                {measurement && <div><dt>Hasil ukur</dt><dd>{measurement.fileCount} file - {measurement.skippedCount} dilewati</dd></div>}
              </dl>
              <div className="detail-actions">
                <button className="button ghost compact" disabled={openingAppId === selectedApp.id} onClick={() => void openAppLocation(selectedApp)}>
                  {openingAppId === selectedApp.id ? "Membuka..." : "Buka lokasi"}
                </button>
                <button className="button ghost compact" disabled={measuring} onClick={() => void measureInstallation(selectedApp)}>
                  {measuring ? "Menghitung..." : "Hitung ukuran folder"}
                </button>
                <button className="button ghost compact" disabled={remnantsLoading} onClick={() => void findRemnants(selectedApp)}>
                  {remnantsLoading ? "Mencari..." : "Cari sisa file"}
                </button>
                <button className="button danger compact" disabled={!selectedApp.supported} onClick={() => setTarget(selectedApp)}>Copot pemasangan</button>
              </div>
              {!selectedApp.supported && <p className="detail-warning">Uninstaller desktop tidak tersedia untuk entri ini.</p>}
              {!selectedApp.installLocation && <p className="detail-warning">Registry tidak mencantumkan lokasi instalasi. Copot pemasangan masih dapat dicoba jika uninstaller tersedia.</p>}
            </>
          ) : (
            <EmptyState>Pilih aplikasi untuk melihat detail dan tindakan yang tersedia.</EmptyState>
          )}
        </aside>
      </div>
      <div className="apps-footer">{selectedApp ? `${selectedApp.name} dipilih - tindakan ada pada panel detail` : "Tidak ada aplikasi dipilih"}</div>
      {remnants && (
        <Panel title={`SISA DATA ${selectedApp?.name?.toUpperCase() ?? "APLIKASI"}`} accent="amber" tag={formatBytes(remnants.totalBytes)}>
          {remnants.items.length ? (
            <>
              <CleanupTable
                report={remnants}
                selected={selectedRemnants}
                onOpen={(id) => void openRemnantLocation(id)}
                onToggle={(id) => setSelectedRemnants((current) => {
                  const next = new Set(current);
                  next.has(id) ? next.delete(id) : next.add(id);
                  return next;
                })}
              />
              <div className="panel-actions">
                <span>{selectedRemnants.size} lokasi dipilih</span>
                <button className="button danger" disabled={!selectedRemnants.size} onClick={() => setConfirmRemnants(true)}>Hapus sisa terpilih</button>
              </div>
            </>
          ) : <EmptyState>Tidak ditemukan folder sisa bernama sama di profil pengguna.</EmptyState>}
        </Panel>
      )}
      {target && (
        <ConfirmDialog
          title={`Copot ${target.name}?`}
          description="LeoDisk akan membuka uninstaller resmi aplikasi. Windows dapat meminta persetujuan UAC."
          confirmLabel={uninstalling ? "Membuka..." : "Buka uninstaller"}
          onCancel={() => setTarget(undefined)}
          onConfirm={() => void uninstall()}
        />
      )}
      {confirmRemnants && (
        <ConfirmDialog
          title="Hapus sisa aplikasi?"
          description="Item ini perlu diperiksa: folder dapat mengandung pengaturan atau data pengguna. Gunakan Recycle Bin untuk opsi pemulihan, atau hapus permanen hanya bila yakin."
          confirmLabel="Hapus permanen"
          alternateLabel="Ke Recycle Bin"
          onCancel={() => setConfirmRemnants(false)}
          onAlternate={() => void removeRemnants(false)}
          onConfirm={() => void removeRemnants(true)}
        />
      )}
    </div>
  );
}

function OptimizePage({ active, notify }: { active: boolean; notify: (message: string) => void }) {
  const [items, setItems] = useState<StartupItem[]>([]);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!active) return;
    invoke<StartupItem[]>("list_startup_items").then(setItems).catch((loadError) => setError(messageOf(loadError)));
  }, [active]);

  const openSettings = async () => {
    try {
      const report = await invoke<ActionReport>("open_startup_settings");
      notify(report.message);
    } catch (settingsError) {
      setError(messageOf(settingsError));
    }
  };
  return (
    <div className="feature-page">
      <div className="page-title">
        <div>
          <h1>Startup Windows</h1>
          <p>LeoDisk hanya membaca daftar startup. Ubah statusnya melalui Settings Windows.</p>
        </div>
        <button className="button primary" onClick={() => void openSettings()}>Buka Startup Apps</button>
      </div>
      <ErrorBanner message={error} />
      <Panel title="ITEM STARTUP" accent="mint" tag={`${items.length} item`}>
        {items.map((item) => (
          <div className="startup-row" key={`${item.source}-${item.name}`}>
            <span><strong>{item.name}</strong><small>{item.command}</small></span>
            <span className="tag mint">{item.source}</span>
          </div>
        ))}
        {!items.length && <EmptyState>Tidak ada startup item yang dapat dibaca.</EmptyState>}
      </Panel>
    </div>
  );
}

type ScanStatus = {
  job?: ScanJob;
  progress?: DiskScanProgress;
  error?: string;
};

function AnalyzePage({
  active,
  notify,
  onScanStatus,
}: {
  active: boolean;
  notify: (message: string) => void;
  onScanStatus: (status: ScanStatus) => void;
}) {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [loadingVolumes, setLoadingVolumes] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [startingScan, setStartingScan] = useState(false);
  const [job, setJob] = useState<ScanJob>();
  const [progress, setProgress] = useState<DiskScanProgress>();
  const [result, setResult] = useState<DiskScanResult>();
  const [resultHistory, setResultHistory] = useState<DiskScanResult[]>([]);
  const [analyzerTab, setAnalyzerTab] = useState("Laporan");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const activeJobId = useRef<string | undefined>(undefined);
  const acceptingStartEvents = useRef(false);
  const pendingProgress = useRef<DiskScanProgress | undefined>(undefined);
  const pendingResult = useRef<DiskScanResult | undefined>(undefined);
  const pendingError = useRef<{ jobId: string; message: string } | undefined>(undefined);
  const readPendingResult = () => pendingResult.current;
  const readPendingError = () => pendingError.current;
  const readPendingProgress = () => pendingProgress.current;

  useEffect(() => {
    onScanStatus({ job, progress, error });
  }, [job, progress, error, onScanStatus]);

  const completeScan = (payload: DiskScanResult) => {
    setResult(payload);
    setResultHistory([]);
    setProgress(undefined);
    setJob(undefined);
    activeJobId.current = undefined;
    setSelected(new Set());
  };
  const failScan = (message: string) => {
    setError(message);
    setJob(undefined);
    setProgress(undefined);
    activeJobId.current = undefined;
  };

  const loadVolumes = async () => {
    setLoadingVolumes(true);
    setError(undefined);
    try {
      setVolumes(await invoke<StorageVolume[]>("list_storage_volumes"));
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoadingVolumes(false);
    }
  };

  useEffect(() => {
    if (active) void loadVolumes();
  }, [active]);

  useEffect(() => {
    let mounted = true;
    setListenersReady(false);
    const handlers = Promise.all([
      listen<DiskScanProgress>("disk-scan-progress", (event) => {
        if (event.payload.jobId === activeJobId.current) {
          setProgress(event.payload);
        } else if (acceptingStartEvents.current) {
          pendingProgress.current = event.payload;
        }
      }),
      listen<DiskScanResult>("disk-scan-complete", (event) => {
        if (event.payload.jobId === activeJobId.current) {
          completeScan(event.payload);
        } else if (acceptingStartEvents.current) {
          pendingResult.current = event.payload;
        }
      }),
      listen<{ jobId: string; message: string }>("disk-scan-error", (event) => {
        if (event.payload.jobId === activeJobId.current) {
          failScan(event.payload.message);
        } else if (acceptingStartEvents.current) {
          pendingError.current = event.payload;
        }
      }),
    ]);
    void handlers.then(() => {
      if (mounted) setListenersReady(true);
    });
    void invoke<ScanJob | null>("get_active_disk_scan")
      .then((activeScan) => {
        if (!mounted || !activeScan || typeof activeScan.jobId !== "string" || typeof activeScan.root !== "string") return;
        activeJobId.current = activeScan.jobId;
        setJob(activeScan);
        setError("Pemindaian masih berjalan di background. Tunggu selesai atau batalkan.");
      })
      .catch(() => {});
    return () => {
      mounted = false;
      setListenersReady(false);
      void handlers.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, []);

  const start = async (root: string) => {
    if (job) {
      setError("Pemindaian masih berjalan di background. Tunggu selesai atau batalkan.");
      return;
    }
    if (startingScan || !listenersReady) return;
    setError(undefined);
    setStartingScan(true);
    acceptingStartEvents.current = true;
    pendingProgress.current = undefined;
    pendingResult.current = undefined;
    pendingError.current = undefined;
    try {
      const nextJob = await invoke<ScanJob>("start_disk_scan", { root });
      activeJobId.current = nextJob.jobId;
      setJob(nextJob);
      const completed = readPendingResult();
      const failed = readPendingError();
      const scanProgress = readPendingProgress();
      if (completed?.jobId === nextJob.jobId) {
        completeScan(completed);
      } else if (failed?.jobId === nextJob.jobId) {
        failScan(failed.message);
      } else if (scanProgress?.jobId === nextJob.jobId) {
        setProgress(scanProgress);
      }
    } catch (scanError) {
      setError(messageOf(scanError));
    } finally {
      acceptingStartEvents.current = false;
      setStartingScan(false);
    }
  };
  const choose = async () => {
    try {
      const chosen = await open({ directory: true, multiple: false, title: "Pilih folder atau drive" });
      if (typeof chosen === "string") await start(chosen);
    } catch (chooseError) {
      setError(messageOf(chooseError));
    }
  };
  const cancel = async () => {
    if (!job) return;
    try {
      await invoke<ActionReport>("cancel_disk_scan", { jobId: job.jobId });
    } catch (cancelError) {
      setError(messageOf(cancelError));
    }
  };
  const deleteLargeFiles = async (permanent: boolean) => {
    setConfirming(false);
    try {
      const report = await invoke<ActionReport>("delete_cleanup_items", { itemIds: [...selected], permanent });
      notify(report.message);
      setResult((current) => current && ({
        ...current,
        largestFiles: current.largestFiles.filter((file) => !selected.has(file.itemId)),
      }));
      setSelected(new Set());
    } catch (deleteError) {
      setError(messageOf(deleteError));
    }
  };
  const openLocation = async (itemId: string) => {
    setError(undefined);
    try {
      const report = await invoke<ActionReport>("open_scanned_location", { itemId });
      notify(report.message);
    } catch (openError) {
      setError(messageOf(openError));
    }
  };
  const focusFolder = (folder: DiskFolder) => {
    if (!result) return;
    const parentCrumb = result.breadcrumbs[result.breadcrumbs.length - 1];
    setResultHistory((history) => [...history, result]);
    setResult({
      ...result,
      root: folder.path,
      rootLocationId: folder.locationId,
      breadcrumbs: [
        ...result.breadcrumbs,
        { locationId: folder.locationId, label: folder.name, path: folder.path },
      ],
      parentLocation: parentCrumb,
      totalBytes: folder.sizeBytes,
      fileCount: folder.fileCount,
      folders: [],
      categories: [],
      largestFiles: result.largestFiles.filter((file) => file.path.toLowerCase().startsWith(folder.path.toLowerCase())),
    });
    setSelected(new Set());
  };
  const goBackFolder = () => {
    setResultHistory((history) => {
      const previous = history[history.length - 1];
      if (previous) setResult(previous);
      return history.slice(0, -1);
    });
  };
  const goToCachedBreadcrumb = (index: number) => {
    if (index >= resultHistory.length) return;
    const target = resultHistory[index];
    setResult(target);
    setResultHistory((history) => history.slice(0, index));
  };
  const openSettings = async (destination: "storage" | "recommendations" | "volumes") => {
    try {
      const report = await invoke<ActionReport>("open_storage_settings", { destination });
      notify(report.message);
    } catch (settingsError) {
      setError(messageOf(settingsError));
    }
  };
  const tiles = result ? treemapLayout(result.folders) : [];
  const busy = !!job || startingScan;
  const analyzerTabs = ["Laporan", "Network Graph", "Treemap", "Largest Files", "Largest Folders", "Review Queue", "Deep Cleaner", "Uninstaller", "Performance", "Pinned (0)", "Browser/App", "History"];
  return (
    <div className="feature-page analyze-page">
      <div className="analyze-toolbar">
        <div className="breadcrumbs">
          <button disabled={busy} onClick={() => { setResult(undefined); setResultHistory([]); }}>Drive</button>
          {result?.breadcrumbs.map((crumb) => (
            <span className="breadcrumb-item" key={crumb.locationId}>
              <span>/</span>
              <button disabled={busy || resultHistory.length === 0} onClick={() => goToCachedBreadcrumb(result.breadcrumbs.findIndex((item) => item.locationId === crumb.locationId))}>{crumb.label}</button>
            </span>
          ))}
        </div>
        <div className="row-buttons">
          <button className="button ghost" disabled={busy || !listenersReady} onClick={() => void choose()}>Pilih lokasi</button>
          {result && <button className="button ghost" onClick={() => void openLocation(result.rootLocationId)}>Buka root</button>}
          {job && <button className="button danger" onClick={() => void cancel()}>Batalkan</button>}
        </div>
      </div>
      <ErrorBanner message={error} />
      {!result && (
        <>
          <div className="storage-settings">
            <button className="button ghost compact" onClick={() => void openSettings("storage")}>Penyimpanan Windows</button>
            <button className="button ghost compact" onClick={() => void openSettings("recommendations")}>Rekomendasi pembersihan</button>
            <button className="button ghost compact" onClick={() => void openSettings("volumes")}>Disk dan volume</button>
          </div>
          <Panel title="PILIH DRIVE UNTUK DIANALISIS" accent="blue" tag={`${volumes.length} volume`}>
            {loadingVolumes && <EmptyState>Memuat drive Windows...</EmptyState>}
            {!loadingVolumes && (
              <div className="volume-grid">
                {volumes.map((volume) => {
                  const used = volume.totalBytes - volume.availableBytes;
                  const usedPercent = volume.totalBytes ? (used / volume.totalBytes) * 100 : 0;
                  return (
                    <article className="volume-card" key={volume.id}>
                      <div className="volume-heading">
                        <strong>{volume.label || volume.root}</strong>
                        {volume.isSystem && <span className="tag amber">SISTEM</span>}
                      </div>
                      <p className="mono">{volume.root} - {volume.filesystem || "Filesystem tidak tersedia"} - {volume.kind}</p>
                      <ProgressBar value={usedPercent} accent="blue" />
                      <p>{formatBytes(used)} terpakai dari {formatBytes(volume.totalBytes)}</p>
                      <div className="volume-flags">
                        {volume.isRemovable && <span>Removable</span>}
                        {volume.isReadOnly && <span>Read-only</span>}
                        <strong>{formatBytes(volume.availableBytes)} kosong</strong>
                      </div>
                      <button className="button primary compact" disabled={busy || !listenersReady} onClick={() => void start(volume.root)}>Pindai</button>
                    </article>
                  );
                })}
                {!volumes.length && <EmptyState>Drive tidak dapat dibaca. Pilih folder secara manual atau coba lagi.</EmptyState>}
              </div>
            )}
          </Panel>
        </>
      )}
      {job && (
        <Panel title="PEMINDAIAN BERJALAN" accent="blue" tag={formatBytes(progress?.bytesScanned ?? 0)}>
          <div className="scan-current">{progress?.currentPath || job.root}</div>
          <p className="muted">
            {progress?.filesScanned ?? 0} file dibaca - {progress?.foldersScanned ?? 0} folder - {progress?.inaccessible ?? 0} dilewati
          </p>
        </Panel>
      )}
      {result && (
        <>
          <Panel title="ANALYZER STORAGE" accent="blue" tag="adaptive_priority_scan - fallback">
            <div className="analyzer-summary">
              <span><strong>{formatBytes(result.totalBytes)}</strong>Total Terindeks</span>
              <span><strong>{formatBytes(result.categories.find((item) => item.label.includes("Data aplikasi"))?.sizeBytes ?? 0)}</strong>Cleanable</span>
              <span><strong>{formatBytes(result.categories.find((item) => item.label.includes("Dokumen"))?.sizeBytes ?? 0)}</strong>Personal Data</span>
              <span><strong>{formatBytes(result.largestFiles.reduce((sum, file) => sum + file.sizeBytes, 0))}</strong>Large Files</span>
              <span><strong>{result.folders.length}</strong>Node Tertangkap</span>
              <span><strong>Fallback</strong>Admin Accel</span>
              <span><strong>{volumes.length}</strong>Volumes</span>
              <span><strong>{result.inaccessible}</strong>Inaccessible</span>
            </div>
            <div className="analyzer-tabs">
              {analyzerTabs.map((item) => (
                <button className={analyzerTab === item ? "active" : ""} key={item} onClick={() => setAnalyzerTab(item)}>{item}</button>
              ))}
            </div>
          </Panel>
          <div className="analyze-layout">
            <aside className="disk-sidebar">
              <div className="disk-orb" />
              <div className="disk-total">
                <strong>{formatBytes(result.totalBytes)}</strong>
                <span>{result.fileCount} file - {result.inaccessible} dilewati</span>
              </div>
              {result.parentLocation && (
                <button className="folder-item parent" disabled={busy || !resultHistory.length} onClick={goBackFolder}>
                  <span>Naik satu folder</span>
                </button>
              )}
              {result.folders.slice(0, 12).map((folder) => (
                <div className="folder-item" key={folder.path}>
                  <button disabled={busy} onClick={() => focusFolder(folder)}>
                    <strong>{folder.name}</strong>
                    <small>{formatBytes(folder.sizeBytes)}</small>
                  </button>
                  <button className="reveal" aria-label={`Buka lokasi ${folder.name}`} onClick={() => void openLocation(folder.locationId)}>Buka</button>
                </div>
              ))}
            </aside>
            <section className="disk-map">
              <header className="map-header">
                <strong>{result.root}</strong>
                <span>{formatBytes(result.totalBytes)} digunakan</span>
              </header>
              <div className="treemap">
                {tiles.map(({ folder, index, left, top, width, height }) => (
                  <button
                    className={`tile tile-${index % 4}`}
                    key={folder.path}
                    style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                    disabled={busy}
                    onClick={() => focusFolder(folder)}
                  >
                    <strong>{folder.name}</strong>
                    <span>{formatBytes(folder.sizeBytes)}</span>
                  </button>
                ))}
                {!tiles.length && <EmptyState>Folder ini tidak berisi file yang dapat dibaca.</EmptyState>}
              </div>
            </section>
          </div>
          <Panel title="PENYEBAB PENGGUNAAN RUANG" accent="mint" tag={`${result.categories.length} kategori`}>
            <div className="category-grid">
              {result.categories.map((category) => (
                <div className={`category-card ${category.colorKey}`} key={category.label}>
                  <span>{category.label}</span>
                  <strong>{formatBytes(category.sizeBytes)}</strong>
                  <small>{category.fileCount} file</small>
                </div>
              ))}
            </div>
            {!!result.inaccessible && (
              <p className="protected-note">
                {result.inaccessible} lokasi terlindungi atau reparse point dilewati. Gunakan Rekomendasi pembersihan Windows untuk area sistem.
              </p>
            )}
          </Panel>
          <Panel title="FILE BESAR - PERIKSA SEBELUM DIHAPUS (MIN. 100 MB)" accent="amber" tag={`${result.largestFiles.length} file`}>
            <div className="large-files-list">
            {result.largestFiles.map((file) => (
              <div className="cleanup-row large-file-row" key={file.itemId}>
                <input type="checkbox" aria-label={`Pilih ${file.name}`} checked={selected.has(file.itemId)} onChange={() => setSelected((current) => {
                  const next = new Set(current);
                  next.has(file.itemId) ? next.delete(file.itemId) : next.add(file.itemId);
                  return next;
                })} />
                <span className="cleanup-name">
                  <strong>{file.name}</strong>
                  <small>{file.path}</small>
                  <small className="safety review">{file.safetyLabel} - {file.safetyNote}</small>
                </span>
                <span className="mono">{formatBytes(file.sizeBytes)}</span>
                <button className="text-action" onClick={() => void openLocation(file.itemId)}>Buka lokasi</button>
              </div>
            ))}
            </div>
            {!result.largestFiles.length && <EmptyState>Tidak ditemukan file di atas 100 MB.</EmptyState>}
            {!!result.largestFiles.length && (
              <div className="panel-actions">
                <span>{selected.size} file dipilih - file besar tidak otomatis aman dihapus</span>
                <button className="button danger" disabled={!selected.size} onClick={() => setConfirming(true)}>Hapus file dipilih</button>
              </div>
            )}
          </Panel>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Hapus file besar?"
          description="File besar bukan cache dan mungkin merupakan data penting. Periksa lokasi terlebih dahulu. Recycle Bin memungkinkan pemulihan; hapus permanen tidak dapat dibatalkan."
          confirmLabel="Hapus permanen"
          alternateLabel="Ke Recycle Bin"
          onCancel={() => setConfirming(false)}
          onAlternate={() => void deleteLargeFiles(false)}
          onConfirm={() => void deleteLargeFiles(true)}
        />
      )}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("status");
  const [latestCleanup, setLatestCleanup] = useState<CleanupReport>();
  const [toast, setToast] = useState<string>();
  const [scanStatus, setScanStatus] = useState<ScanStatus>({});
  const currentLabel = useMemo(() => tabs.find((item) => item.id === tab)?.label, [tab]);
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 4000);
  };
  const cancelActiveScan = async () => {
    if (!scanStatus.job) return;
    try {
      const report = await invoke<ActionReport>("cancel_disk_scan", { jobId: scanStatus.job.jobId });
      notify(report.message);
    } catch (cancelError) {
      notify(messageOf(cancelError));
    }
  };

  return (
    <AppErrorBoundary>
      <main className="app-shell">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">L</span><strong>LeoDisk</strong></div>
          <nav className="nav-pill" aria-label="Navigasi utama">
            {tabs.map((item) => (
              <button
                key={item.id}
                className={tab === item.id ? "active" : ""}
                onClick={() => setTab(item.id)}
              >
                <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="topbar-status">
            <span className="current-tab">{currentLabel}</span>
            {scanStatus.job && (
              <div className="scan-chip" role="status">
                <button className="text-action" onClick={() => setTab("analyze")}>Scan: {scanStatus.job.root}</button>
                <span>{scanStatus.progress?.filesScanned ?? 0} file</span>
                <button className="text-action" onClick={() => void cancelActiveScan()}>Batalkan</button>
              </div>
            )}
          </div>
        </header>
        <div className="workspace">
          {tab === "status" && <StatusPage active latestCleanup={latestCleanup} />}
          {tab === "clean" && <CleanPage onReport={setLatestCleanup} notify={notify} />}
          {tab === "purge" && <PurgePage notify={notify} />}
          {tab === "apps" && <AppsPage active notify={notify} />}
          {tab === "optimize" && <OptimizePage active notify={notify} />}
          {tab === "performance" && <PerformancePage active />}
          <div hidden={tab !== "analyze"}>
            <AnalyzePage active={tab === "analyze"} notify={notify} onScanStatus={setScanStatus} />
          </div>
        </div>
        {toast && <Toast message={toast} onClose={() => setToast(undefined)} />}
      </main>
    </AppErrorBoundary>
  );
}

export default App;
