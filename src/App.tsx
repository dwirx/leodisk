import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  AppWindow,
  Archive,
  BarChart3,
  Check,
  ChevronUp,
  Clipboard,
  Database,
  Download,
  Eraser,
  FileArchive,
  FileSearch,
  FolderOpen,
  Info,
  Gauge,
  LayoutDashboard,
  Loader2,
  MonitorCog,
  PackageOpen,
  PieChart as PieIcon,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
  CleanupDeleteProgress,
  CleanupReport,
  CleanupScanProgress,
  DiskScanProgress,
  DiskScanResult,
  DiskFolder,
  InstalledApp,
  ProcessMetric,
  ScanJob,
  StorageVolume,
  StartupItem,
  SystemSnapshot,
  Tab,
  WizTreeStatus,
} from "./types";
import "./App.css";

type TabConfig = { id: Tab; label: string; icon: LucideIcon };
type AnalyzerTab = { id: string; label: string; icon: LucideIcon };

const defaultTabs: TabConfig[] = [
  { id: "clean", label: "Bersihkan", icon: Sparkles },
  { id: "purge", label: "Purge", icon: Eraser },
  { id: "apps", label: "Aplikasi", icon: AppWindow },
  { id: "optimize", label: "Optimalkan", icon: MonitorCog },
  { id: "analyze", label: "Analisis", icon: BarChart3 },
  { id: "performance", label: "Performa", icon: Gauge },
  { id: "status", label: "Status", icon: LayoutDashboard },
];

const defaultAnalyzerTabs: AnalyzerTab[] = [
  { id: "report", label: "Laporan", icon: FileSearch },
  { id: "network", label: "Network Graph", icon: Activity },
  { id: "treemap", label: "Treemap", icon: PieIcon },
  { id: "files", label: "Largest Files", icon: FileArchive },
  { id: "folders", label: "Largest Folders", icon: FolderOpen },
  { id: "review", label: "Review Queue", icon: ShieldAlert },
  { id: "deep", label: "Deep Cleaner", icon: Sparkles },
  { id: "uninstaller", label: "Uninstaller", icon: PackageOpen },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "pinned", label: "Pinned (0)", icon: Check },
  { id: "browser", label: "Browser/App", icon: AppWindow },
  { id: "history", label: "History", icon: Archive },
];

const CHART_COLORS = ["#4bc49c", "#579be6", "#e8af62", "#dc7763", "#b8a989", "#8dd5f7"];
const ADMIN_CONFIRMATION_PHRASE = "SAYA MENGERTI";
type CleanupDecision = NonNullable<CleanupItem["decision"]>;
type DiskScanEngineId = "native" | "dust" | "wiztree";
const scanEngineOptions: Array<{ id: DiskScanEngineId; label: string; detail: string }> = [
  { id: "native", label: "Native", detail: "Scanner Rust LeoDisk" },
  { id: "dust", label: "Dust", detail: "Aggregator Rust gaya dust" },
  { id: "wiztree", label: "WizTree", detail: "CLI CSV cache tunggal" },
];
const cleanupScopes = [
  ["%TEMP%", "Windows Temp", "Recycle Bin"],
  ["Chrome", "Edge", "Firefox"],
  ["Node.js", "npm/yarn/pnpm", "Python/pip"],
  ["Spotify", "Slack", "VS Code"],
  ["Windows logs", "Crash dumps", "Shader cache"],
];
const remnantScopes = [
  ["AppData", "cache", "logs"],
  ["preferences/config", "extensions/plugins", "local storage"],
  ["registry uninstall dibaca", "registry tidak dihapus otomatis", "sisa folder direview"],
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

function useWizTreeTools(notify?: (message: string) => void) {
  const [status, setStatus] = useState<WizTreeStatus>();
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = async () => {
    setLoading(true);
    try {
      const next = await invoke<WizTreeStatus>("get_wiztree_status");
      setStatus(next);
      setError(undefined);
      return next;
    } catch (statusError) {
      const message = messageOf(statusError);
      setError(message);
      return undefined;
    } finally {
      setLoading(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    try {
      const next = await invoke<WizTreeStatus>("install_wiztree_portable");
      setStatus(next);
      setError(undefined);
      notify?.(next.message);
      return next;
    } catch (installError) {
      const message = messageOf(installError);
      setError(message);
      notify?.(message);
      return undefined;
    } finally {
      setInstalling(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    try {
      const next = await invoke<WizTreeStatus>("verify_wiztree_status");
      setStatus(next);
      setError(next.lastError ?? undefined);
      notify?.(next.message);
      return next;
    } catch (verifyError) {
      const message = messageOf(verifyError);
      setError(message);
      notify?.(message);
      return undefined;
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return { status, loading, verifying, installing, error, refresh, verify, install };
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
  const topCpu = snapshot?.processes.reduce<ProcessMetric | undefined>(
    (top, process) => !top || process.cpuPercent > top.cpuPercent ? process : top,
    undefined,
  );
  const topMemory = snapshot?.processes.reduce<ProcessMetric | undefined>(
    (top, process) => !top || process.memoryBytes > top.memoryBytes ? process : top,
    undefined,
  );
  const loadSignals = [
    snapshot && snapshot.cpuPercent >= 80 ? "CPU tinggi" : undefined,
    memoryPercent !== undefined && memoryPercent >= 80 ? "Memori tinggi" : undefined,
    diskPercent !== undefined && diskPercent >= 88 ? "Disk hampir penuh" : undefined,
    snapshot && (snapshot.networkDownPerSec + snapshot.networkUpPerSec) > 1024 * 1024 ? "Network aktif" : undefined,
  ].filter((item): item is string => Boolean(item));

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
      <div className="status-insights">
        <Panel title="PROSES TERBERAT" accent="amber" tag={topCpu ? formatPercent(topCpu.cpuPercent) : "--"}>
          <div className="insight-row"><span>CPU</span><strong>{topCpu?.name ?? "Tidak ada data"}</strong><small>{topCpu ? `PID ${topCpu.pid}` : "--"}</small></div>
          <div className="insight-row"><span>Memori</span><strong>{topMemory?.name ?? "Tidak ada data"}</strong><small>{topMemory ? formatBytes(topMemory.memoryBytes) : "--"}</small></div>
        </Panel>
        <Panel title="HEALTH INPUT" accent={loadSignals.length ? "amber" : "mint"} tag={`${loadSignals.length} sinyal`}>
          <div className="health-flags">
            {(loadSignals.length ? loadSignals : ["Stabil"]).map((signal) => <span key={signal}>{signal}</span>)}
          </div>
          <p className="muted">CPU, memori, disk, network, dan proses berat dihitung dari snapshot real-time.</p>
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
    reviewBytes: report.items.filter((item) => decisionOf(item) === "review").reduce((sum, item) => sum + item.sizeBytes, 0),
    reviewItems: report.items.filter((item) => decisionOf(item) === "review").length,
    manualBytes: report.items.filter((item) => decisionOf(item) === "manual").reduce((sum, item) => sum + item.sizeBytes, 0),
    manualItems: report.items.filter((item) => decisionOf(item) === "manual").length,
    adminBytes: report.items.filter((item) => decisionOf(item) === "admin").reduce((sum, item) => sum + item.sizeBytes, 0),
    adminItems: report.items.filter((item) => decisionOf(item) === "admin").length,
    advisoryBytes: report.advisories?.reduce((sum, item) => sum + item.sizeBytes, 0) ?? 0,
    advisoryItems: report.advisories?.length ?? 0,
  };
}

function decisionOf(item: CleanupItem): CleanupDecision {
  return item.decision ?? (item.safeToDelete ? "clean" : "review");
}

function formatElapsed(ms?: number | null) {
  if (!ms || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function riskLabel(value?: string) {
  if (value === "high") return "Risiko Tinggi";
  if (value === "medium") return "Risiko Sedang";
  return "Risiko Rendah";
}

function decisionLabel(value?: string) {
  if (value === "admin") return "Admin Clean";
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
  if (source.includes("admin") || source.includes("protected") || source.includes("system")) return "AD";
  if (source.includes("manual") || source.includes("installer")) return "MN";
  if (source.includes("advisory") || source.includes("memory") || source.includes("power")) return "AD";
  return (item.category || "IT").slice(0, 2).toUpperCase();
}

function cleanupExplanation(item: CleanupItem) {
  const source = `${item.name ?? ""} ${item.category} ${item.path}`.toLowerCase();
  if (source.includes("windows temp") || source.includes("\\windows\\temp")) {
    return "File sementara milik sistem Windows. Dibuat saat proses instalasi, update, atau error sistem. Salah satu tersangka klasik yang sering diabaikan.";
  }
  if (source.includes("browser") || source.includes("chrome") || source.includes("edge") || source.includes("firefox")) {
    return "Cache browser mempercepat halaman yang sering dibuka, tetapi bisa membesar setelah update, crash, atau pemakaian lama.";
  }
  if (source.includes("npm") || source.includes("yarn") || source.includes("pnpm") || source.includes("bun") || source.includes("cargo") || source.includes("gradle")) {
    return "Cache dependency developer dapat dibuat ulang oleh package manager. Ukurannya sering besar karena menyimpan banyak versi paket dan artefak build.";
  }
  if (source.includes("shader") || source.includes("gpu") || source.includes("nvidia") || source.includes("amd")) {
    return "Cache shader/GPU membantu aplikasi dan game membuka render lebih cepat. File ini bisa dibuat ulang setelah cleanup.";
  }
  if (decisionOf(item) === "advisory") {
    return "Temuan ini menjelaskan penyebab ruang disk terpakai, tetapi tidak dimasukkan ke pembersihan otomatis karena berada di area sistem atau data pribadi.";
  }
  return item.recommendation || item.safetyNote || "Item ditemukan dari daftar lokasi cleanup yang dikenal dan sudah diberi label keputusan berdasarkan tingkat risikonya.";
}

function cleaningMethod(item: CleanupItem) {
  const source = `${item.name ?? ""} ${item.category} ${item.path}`.toLowerCase();
  if (source.includes("\\windows\\temp") || source.includes("windows temp")) return "Disk Cleanup > Temporary files";
  if (source.includes("browser") || source.includes("chrome") || source.includes("edge") || source.includes("firefox")) return "Tutup browser > bersihkan dari LeoDisk atau pengaturan browser";
  if (decisionOf(item) === "clean") return "Tambahkan ke Batch Clean";
  if (decisionOf(item) === "admin") return `Review item > Izinkan Admin Clean > ketik ${ADMIN_CONFIRMATION_PHRASE}`;
  if (decisionOf(item) === "manual") return "Buka lokasi > review manual";
  if (decisionOf(item) === "advisory") return "Audit ukuran > gunakan Settings/alat resmi Windows";
  return "Buka lokasi > pastikan tidak dipakai > review manual";
}

function preflightStatus(item: CleanupItem) {
  const decision = decisionOf(item);
  if (item.skippedCount > 0) return "Sebagian Terbatas";
  if (decision === "clean") return "Lolos";
  if (decision === "admin") return "Butuh Konfirmasi";
  if (decision === "advisory") return "Audit Saja";
  return "Butuh Review";
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function ButtonIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="button-icon" aria-hidden="true" size={16} strokeWidth={2.2} />;
}

function TabIcon({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon className="nav-icon" aria-hidden="true" size={17} strokeWidth={2.3} />;
}

function SortableTabButton({
  id,
  active,
  icon,
  label,
  onClick,
  className = "",
}: {
  id: string;
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      className={`${active ? "active" : ""} ${isDragging ? "dragging" : ""} ${className}`}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      <TabIcon icon={icon} />
      {label}
    </button>
  );
}

function useSortableSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

function statusText(report: CleanupReport) {
  const summary = cleanupSummary(report);
  const level = summary.totalJunkBytes >= 10 * 1024 * 1024 * 1024 ? "Kritis" : summary.totalJunkBytes ? "Perlu Perhatian" : "Bersih";
  return `${level}. ${formatBytes(summary.totalJunkBytes)} junk ditemukan dan ${formatBytes(summary.cleanableBytes)} siap dibersihkan sekarang.`;
}

function decisionChartData(items: CleanupItem[]) {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(decisionLabel(decisionOf(item)), (totals.get(decisionLabel(decisionOf(item))) ?? 0) + item.sizeBytes);
  }
  return [...totals.entries()].map(([name, value]) => ({ name, value }));
}

function riskChartData(items: CleanupItem[]) {
  const totals = new Map<string, number>();
  for (const item of items) {
    const risk = riskLabel(item.riskLevel);
    totals.set(risk, (totals.get(risk) ?? 0) + item.sizeBytes);
  }
  return [...totals.entries()].map(([name, value]) => ({ name, value }));
}

function categoryChartData(report: CleanupReport) {
  return (report.categoryTotals ?? [])
    .map((item) => ({
      name: item.category,
      group: item.group,
      value: item.sizeBytes,
      files: item.fileCount,
      items: item.itemCount,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
}

function ByteTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value?: number; payload?: Record<string, unknown> }>; label?: string }) {
  if (!active || !payload?.length) return null;
  const value = payload[0]?.value ?? 0;
  const detail = payload[0]?.payload;
  return (
    <div className="chart-tooltip">
      <strong>{label ?? String(detail?.name ?? "")}</strong>
      <span>{formatBytes(value)}</span>
      {typeof detail?.files === "number" && <small>{detail.files} file</small>}
      {typeof detail?.items === "number" && <small>{detail.items} item</small>}
    </div>
  );
}

function CleanupCharts({
  report,
  selectedCategory,
  onSelectCategory,
}: {
  report: CleanupReport;
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
}) {
  const allItems = [...report.items, ...(report.advisories ?? [])];
  const categories = categoryChartData(report);
  const decisions = decisionChartData(allItems);
  const risks = riskChartData(allItems);
  return (
    <div className="chart-grid cleanup-charts">
      <Panel title="GRAFIK KATEGORI" accent="blue" tag={selectedCategory || "Semua"}>
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
            <BarChart data={categories} margin={{ top: 6, right: 8, bottom: 36, left: 4 }}>
              <CartesianGrid stroke="rgba(236,222,190,0.1)" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: "#b7afa2", fontSize: 11 }} interval={0} angle={-22} textAnchor="end" height={50} />
              <YAxis tick={{ fill: "#b7afa2", fontSize: 11 }} tickFormatter={(value) => formatBytes(Number(value)).replace(" ", "")} width={58} />
              <Tooltip content={<ByteTooltip />} />
              <Bar dataKey="value" radius={[7, 7, 2, 2]} onClick={(data) => onSelectCategory(String(data.name ?? ""))}>
                {categories.map((entry, index) => (
                  <Cell key={entry.name} fill={entry.name === selectedCategory ? "#f2ede4" : CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <Panel title="KEPUTUSAN" accent="mint">
        <div className="chart-box compact-chart">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
            <PieChart>
              <Pie data={decisions} dataKey="value" nameKey="name" innerRadius={48} outerRadius={82} paddingAngle={3}>
                {decisions.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
              </Pie>
              <Tooltip content={<ByteTooltip />} />
              <Legend wrapperStyle={{ color: "#b7afa2", fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <Panel title="RISIKO" accent="amber">
        <div className="chart-box compact-chart">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
            <PieChart>
              <Pie data={risks} dataKey="value" nameKey="name" innerRadius={46} outerRadius={80} paddingAngle={3}>
                {risks.map((entry, index) => <Cell key={entry.name} fill={CHART_COLORS[(index + 2) % CHART_COLORS.length]} />)}
              </Pie>
              <Tooltip content={<ByteTooltip />} />
              <Legend wrapperStyle={{ color: "#b7afa2", fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </div>
  );
}

function CleanupEvidenceCard({
  item,
  selectable,
  adminApproved,
  onApproveAdmin,
  onOpen,
  onCopy,
}: {
  item: CleanupItem;
  selectable: boolean;
  adminApproved?: boolean;
  onApproveAdmin?: () => void;
  onOpen: () => void;
  onCopy: (value: string) => void;
}) {
  const decision = decisionOf(item);
  const isAdmin = decision === "admin";
  const method = cleaningMethod(item);
  const evidence = [
    ["Path", item.exists === false ? "Tidak ditemukan" : "Ditemukan"],
    ["Akses", item.skippedCount ? "Sebagian Terbatas" : "Bisa Dibaca"],
    ["Tipe", item.kind === "file" ? "File" : "Direktori"],
    ["Preflight", preflightStatus(item)],
    ["Estimasi", formatBytes(item.sizeBytes)],
    ["Skip", String(item.skippedCount)],
  ];
  return (
    <div className="cleanup-row-detail scan-detail-card">
      <section className="scan-detail-section location">
        <h3><FolderOpen size={14} aria-hidden="true" /> Lokasi</h3>
        <code>{item.path}</code>
        <div className="detail-actions">
          <button className="button ghost compact" onClick={onOpen}><ButtonIcon icon={FolderOpen} />Buka Folder</button>
          <button className="button ghost compact" onClick={() => onCopy(item.path)}><ButtonIcon icon={Clipboard} />Salin</button>
        </div>
      </section>
      <section className="scan-detail-section">
        <h3><Info size={14} aria-hidden="true" /> Penjelasan</h3>
        <p>{cleanupExplanation(item)}</p>
      </section>
      <section className="scan-detail-section">
        <h3><ShieldCheck size={14} aria-hidden="true" /> Keputusan Cleaner</h3>
        <p>{item.safetyNote || item.recommendation}</p>
        <div className="detail-badges">
          <span className={`mini-badge ${decision}`}>{decisionLabel(decision)}</span>
          <span className={`mini-badge risk-${item.riskLevel ?? "low"}`}>{riskLabel(item.riskLevel)}</span>
        </div>
      </section>
      <section className="scan-detail-section">
        <h3><ShieldAlert size={14} aria-hidden="true" /> Catatan Keamanan</h3>
        <p>{item.safetyLabel}. {isAdmin ? `Item admin tidak dipilih otomatis. Aktifkan hanya jika Anda siap mengetik ${ADMIN_CONFIRMATION_PHRASE} pada dialog hapus.` : selectable ? "Windows atau aplikasi akan membuat ulang jika diperlukan. File yang sedang dipakai akan dilewati." : "Item ini tidak dipilih otomatis. Review isi dan konteksnya sebelum tindakan manual."}</p>
      </section>
      <section className="scan-detail-section evidence">
        <h3><FileSearch size={14} aria-hidden="true" /> Preflight Evidence</h3>
        <div className="evidence-grid">
          {evidence.map(([label, value]) => (
            <span key={label}>
              <small>{label}</small>
              <strong>{value}</strong>
            </span>
          ))}
        </div>
      </section>
      <section className="scan-detail-section">
        <h3><Sparkles size={14} aria-hidden="true" /> Cara Membersihkan</h3>
        <div className="method-row">
          <code>{method}</code>
          <button className="button ghost compact" onClick={() => onCopy(method)}><ButtonIcon icon={Clipboard} />Salin</button>
        </div>
        {isAdmin && (
          <button className={`button compact ${adminApproved ? "ghost dashed" : "danger"}`} onClick={onApproveAdmin} disabled={adminApproved}>
            <ButtonIcon icon={ShieldAlert} />
            {adminApproved ? "Admin Clean Diizinkan" : "Saya paham risiko"}
          </button>
        )}
        {selectable && <button className="button ghost compact dashed" disabled>Tambahkan ke Batch Clean</button>}
      </section>
    </div>
  );
}

function CleanupConfirmDialog({
  cleanCount,
  adminCount,
  totalBytes,
  skippedCount,
  phrase,
  onPhraseChange,
  onCancel,
  onRecycle,
  onPermanent,
}: {
  cleanCount: number;
  adminCount: number;
  totalBytes: number;
  skippedCount: number;
  phrase: string;
  onPhraseChange: (value: string) => void;
  onCancel: () => void;
  onRecycle: () => void;
  onPermanent: () => void;
}) {
  const hasAdmin = adminCount > 0;
  const adminReady = !hasAdmin || phrase.trim() === ADMIN_CONFIRMATION_PHRASE;
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog admin-clean-dialog" role="dialog" aria-modal="true" aria-label="Bersihkan item terpilih?">
        <div className="dialog-title-row">
          <span>
            <h2>Bersihkan item terpilih?</h2>
            <p>
              LeoDisk akan memproses item yang dipilih, melewati file yang terkunci, dan tidak menghapus folder induk sistem.
            </p>
          </span>
        </div>
        <div className="confirm-summary-grid">
          <span><small>Clean biasa</small><strong>{cleanCount}</strong></span>
          <span><small>Admin clean</small><strong>{adminCount}</strong></span>
          <span><small>Total estimasi</small><strong>{formatBytes(totalBytes)}</strong></span>
          <span><small>Mungkin dilewati</small><strong>{skippedCount}</strong></span>
        </div>
        {hasAdmin && (
          <label className="phrase-confirm">
            <span>Ketik <strong>{ADMIN_CONFIRMATION_PHRASE}</strong> untuk mengizinkan Admin Clean.</span>
            <input
              value={phrase}
              onChange={(event) => onPhraseChange(event.target.value)}
              placeholder={ADMIN_CONFIRMATION_PHRASE}
              aria-label="Phrase konfirmasi Admin Clean"
              autoFocus
            />
          </label>
        )}
        <div className="dialog-actions">
          <button className="button ghost" onClick={onCancel}>Batal</button>
          <button className="button ghost" disabled={!adminReady} onClick={onRecycle}>
            <ButtonIcon icon={Archive} />
            Ke Recycle Bin
          </button>
          <button className="button danger" disabled={!adminReady} onClick={onPermanent}>
            <ButtonIcon icon={Trash2} />
            Hapus permanen
          </button>
        </div>
      </div>
    </div>
  );
}

function ScanProgressPanel({
  title,
  detail,
  phase,
  value,
  stats = [],
  action,
}: {
  title: string;
  detail: string;
  phase?: string;
  value?: number;
  stats?: Array<[string, string | number]>;
  action?: ReactNode;
}) {
  return (
    <Panel className="scan-progress-panel" title="SCAN BERJALAN" accent="blue" tag="live">
      <div className="scan-progress-head">
        <span>
          <strong>{title}</strong>
          {phase && <small className="scan-progress-phase">{phase}</small>}
          <p>{detail}</p>
        </span>
        <span className="scan-progress-actions">
          {action}
          <Loader2 size={22} aria-hidden="true" />
        </span>
      </div>
      <ProgressBar value={value} indeterminate={value === undefined} accent="blue" />
      {!!stats.length && (
        <div className="scan-progress-stats">
          {stats.map(([label, value]) => (
            <span key={label}><strong>{value}</strong>{label}</span>
          ))}
        </div>
      )}
    </Panel>
  );
}

function WizTreeStatusPanel({
  status,
  loading,
  installing,
  verifying,
  error,
  onRefresh,
  onVerify,
  onInstall,
}: {
  status?: WizTreeStatus;
  loading: boolean;
  installing: boolean;
  verifying: boolean;
  error?: string;
  onRefresh: () => void;
  onVerify: () => void;
  onInstall: () => void;
}) {
  const available = !!status?.available;
  const verified = !!status?.verified;
  return (
    <Panel className={`wiztree-status-panel ${verified ? "ready" : "missing"}`} title="WIZTREE CLI" accent={verified ? "mint" : "amber"} tag={verified ? "Lulus uji" : available ? "Belum diuji" : "Perlu download"}>
      <div className="wiztree-status-layout">
        <span className="wiztree-status-dot" aria-hidden="true" />
        <div className="wiztree-status-copy">
          <strong>{verified ? "WizTree siap dipakai" : available ? "WizTree terdeteksi, perlu uji CLI" : "WizTree portable belum ditemukan"}</strong>
          <p>{error ?? status?.lastError ?? status?.message ?? "LeoDisk akan menjalankan export kecil lebih dulu untuk memastikan WizTree benar-benar bekerja."}</p>
          <code>{available ? status?.executablePath : status?.installDir}</code>
        </div>
        <div className="wiztree-status-actions">
          <button className="button ghost compact" disabled={loading || installing || verifying} onClick={onRefresh}>
            <ButtonIcon icon={Search} />
            Cek ulang
          </button>
          {available && (
            <button className="button ghost compact" disabled={installing || verifying} onClick={onVerify}>
              <ButtonIcon icon={verifying ? Loader2 : Check} />
              {verifying ? "Menguji..." : "Uji WizTree"}
            </button>
          )}
          {!available && (
            <button className="button primary compact" disabled={installing} onClick={onInstall}>
              <ButtonIcon icon={installing ? Loader2 : Download} />
              {installing ? "Download..." : "Download portable"}
            </button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function CleanupItemGraph({
  items,
  onFocus,
  onOpen,
}: {
  items: CleanupItem[];
  onFocus: (item: CleanupItem) => void;
  onOpen: (itemId: string) => void;
}) {
  const topItems = items
    .filter((item) => item.sizeBytes > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 14);
  const maxSize = Math.max(...topItems.map((item) => item.sizeBytes), 1);
  return (
    <Panel title="GRAPH CLEANUP INTERAKTIF" accent="blue" tag={`${topItems.length} item terbesar`}>
      <div className="folder-graph cleanup-item-graph">
        {topItems.map((item, index) => {
          const percent = Math.max(4, (item.sizeBytes / maxSize) * 100);
          return (
            <article className={`folder-graph-row cleanup-graph-row ${decisionOf(item)}`} key={item.id}>
              <button
                className="folder-graph-track"
                onClick={() => onFocus(item)}
                style={{ "--bar": `${percent}%` } as CSSProperties}
              >
                <span className="folder-graph-rank">{String(index + 1).padStart(2, "0")}</span>
                <span className="folder-graph-name">
                  <strong>{item.name ?? item.category}</strong>
                  <small>{item.path}</small>
                </span>
                <span className="folder-graph-size">
                  <strong>{formatBytes(item.sizeBytes)}</strong>
                  <small>{decisionOf(item)} - {item.fileCount} file</small>
                </span>
              </button>
              <button className="text-action folder-graph-open" onClick={() => onOpen(item.id)}>
                Buka
              </button>
            </article>
          );
        })}
        {!topItems.length && <EmptyState>Tidak ada item cleanup berukuran besar untuk graph.</EmptyState>}
      </div>
    </Panel>
  );
}

function CleanPage({
  onReport,
  onStatus,
  notify,
}: {
  onReport: (report: CleanupReport) => void;
  onStatus: (status: CleanupStatus) => void;
  notify: (message: string) => void;
}) {
  const [report, setReport] = useState<CleanupReport>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adminUnlocked, setAdminUnlocked] = useState<Set<string>>(new Set());
  const [adminPhrase, setAdminPhrase] = useState("");
  const [query, setQuery] = useState("");
  const [riskFilter, setRiskFilter] = useState<"all" | "low" | "medium" | "high">("all");
  const [decisionFilter, setDecisionFilter] = useState<"all" | CleanupDecision>("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sizeFilter, setSizeFilter] = useState<0 | 100 | 500 | 1024>(0);
  const [sort, setSort] = useState<"size" | "name" | "priority">("size");
  const [scanEngine, setScanEngine] = useState<DiskScanEngineId>("native");
  const [visibleLimit, setVisibleLimit] = useState(80);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [, setListenersReady] = useState(false);
  const [scanJob, setScanJob] = useState<ScanJob>();
  const [scanProgress, setScanProgress] = useState<CleanupScanProgress>();
  const [deleteJob, setDeleteJob] = useState<ScanJob>();
  const [deleteProgress, setDeleteProgress] = useState<CleanupDeleteProgress>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const wizTree = useWizTreeTools(notify);
  const scanJobId = useRef<string | undefined>(undefined);
  const deleteJobId = useRef<string | undefined>(undefined);
  const acceptingScanStart = useRef(false);
  const pendingScanReport = useRef<CleanupReport | undefined>(undefined);
  const pendingScanProgress = useRef<CleanupScanProgress | undefined>(undefined);
  const pendingScanError = useRef<{ jobId: string; message: string } | undefined>(undefined);
  const deletingIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (report) onReport(report);
  }, [onReport, report]);

  useEffect(() => {
    onStatus({ scanJob, scanProgress, deleteJob, deleteProgress, error });
  }, [deleteJob, deleteProgress, error, onStatus, scanJob, scanProgress]);

  const applyCleanupReport = (result: CleanupReport) => {
    setReport(result);
    setSelected(new Set(result.items.filter((item) => decisionOf(item) === "clean").map((item) => item.id)));
    setAdminUnlocked(new Set());
    setAdminPhrase("");
    setReviewed(new Set());
    setExpanded(new Set(result.items[0] ? [result.items[0].id] : []));
    setVisibleLimit(80);
  };

  const completeScan = (result: CleanupReport) => {
    applyCleanupReport(result);
    setScanProgress(undefined);
    setScanJob(undefined);
    scanJobId.current = undefined;
    setLoading(false);
  };

  const failScan = (message: string) => {
    setError(message);
    setScanProgress(undefined);
    setScanJob(undefined);
    scanJobId.current = undefined;
    setLoading(false);
  };

  const completeDelete = (result: ActionReport) => {
    notify(result.message);
    setReport((current) => {
      if (!current) return current;
      const removed = deletingIds.current;
      const nextItems = current.items.filter((item) => !removed.has(item.id));
      return {
        ...current,
        items: nextItems,
        totalBytes: nextItems.reduce((sum, item) => sum + item.sizeBytes, 0),
        totalFiles: nextItems.reduce((sum, item) => sum + item.fileCount, 0),
        skippedCount: nextItems.reduce((sum, item) => sum + item.skippedCount, 0),
        summary: undefined,
        categoryTotals: undefined,
      };
    });
    deletingIds.current = new Set();
    setSelected(new Set());
    setAdminUnlocked(new Set());
    setAdminPhrase("");
    setDeleteProgress(undefined);
    setDeleteJob(undefined);
    deleteJobId.current = undefined;
  };

  const failDelete = (message: string) => {
    setError(message);
    deletingIds.current = new Set();
    setDeleteProgress(undefined);
    setDeleteJob(undefined);
    deleteJobId.current = undefined;
  };

  useEffect(() => {
    let mounted = true;
    setListenersReady(false);
    const handlers = Promise.all([
      listen<CleanupScanProgress>("cleanup-scan-progress", (event) => {
        const payload = event.payload;
        if (payload.jobId === scanJobId.current) {
          setScanProgress(payload);
        } else if (acceptingScanStart.current) {
          pendingScanProgress.current = payload;
        }
      }),
      listen<CleanupReport>("cleanup-scan-complete", (event) => {
        if (scanJobId.current || acceptingScanStart.current) {
          pendingScanReport.current = event.payload;
          completeScan(event.payload);
        }
      }),
      listen<{ jobId: string; message: string }>("cleanup-scan-error", (event) => {
        if (event.payload.jobId === scanJobId.current) {
          failScan(event.payload.message);
        } else if (acceptingScanStart.current) {
          pendingScanError.current = event.payload;
        }
      }),
      listen<CleanupDeleteProgress>("cleanup-delete-progress", (event) => {
        if (event.payload.jobId === deleteJobId.current) {
          setDeleteProgress(event.payload);
        }
      }),
      listen<ActionReport>("cleanup-delete-complete", (event) => {
        if (deleteJobId.current) completeDelete(event.payload);
      }),
      listen<{ jobId: string; message: string }>("cleanup-delete-error", (event) => {
        if (event.payload.jobId === deleteJobId.current) failDelete(event.payload.message);
      }),
    ]);
    void handlers.then(() => {
      if (mounted) setListenersReady(true);
    });
    void invoke<ScanJob | null>("get_active_cleanup_scan")
      .then((activeScan) => {
        if (!mounted || !activeScan) return;
        scanJobId.current = activeScan.jobId;
        setScanJob(activeScan);
        setLoading(true);
        setError("Scan cleanup masih berjalan di background. Anda bisa pindah tab tanpa scan ulang.");
      })
      .catch(() => {});
    void invoke<ScanJob | null>("get_active_cleanup_delete")
      .then((activeDelete) => {
        if (!mounted || !activeDelete) return;
        deleteJobId.current = activeDelete.jobId;
        setDeleteJob(activeDelete);
      })
      .catch(() => {});
    return () => {
      mounted = false;
      setListenersReady(false);
      void handlers.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, []);

  const scan = async () => {
    if (scanJob || loading) return;
    setLoading(true);
    setError(undefined);
    acceptingScanStart.current = true;
    pendingScanReport.current = undefined;
    pendingScanProgress.current = undefined;
    pendingScanError.current = undefined;
    try {
      const nextJob = await invoke<ScanJob>("start_cleanup_scan", { scanEngine });
      scanJobId.current = nextJob.jobId;
      setScanJob(nextJob);
      const completed = pendingScanReport.current as CleanupReport | undefined;
      const failed = pendingScanError.current as { jobId: string; message: string } | undefined;
      const progressEvent = pendingScanProgress.current as CleanupScanProgress | undefined;
      if (completed) {
        completeScan(completed);
      } else if (failed?.jobId === nextJob.jobId) {
        failScan(failed.message);
      } else if (progressEvent?.jobId === nextJob.jobId) {
        setScanProgress(progressEvent);
      }
    } catch (scanError) {
      setError(messageOf(scanError));
      setLoading(false);
    } finally {
      acceptingScanStart.current = false;
    }
  };

  const cancelScan = async () => {
    if (!scanJob) return;
    try {
      const result = await invoke<ActionReport>("cancel_cleanup_scan", { jobId: scanJob.jobId });
      notify(result.message);
    } catch (cancelError) {
      setError(messageOf(cancelError));
    }
  };

  const remove = async (permanent: boolean) => {
    if (deleteJob) return;
    const selectedItems = allItems.filter((item) => selected.has(item.id));
    const hasAdmin = selectedItems.some((item) => decisionOf(item) === "admin");
    if (hasAdmin && adminPhrase.trim() !== ADMIN_CONFIRMATION_PHRASE) {
      setError(`Ketik ${ADMIN_CONFIRMATION_PHRASE} untuk mengonfirmasi Admin Clean.`);
      return;
    }
    setConfirming(false);
    setError(undefined);
    deletingIds.current = new Set(selected);
    try {
      const nextJob = await invoke<ScanJob>("start_cleanup_delete", {
        itemIds: [...selected],
        permanent,
        adminConfirmed: hasAdmin,
        adminConfirmationPhrase: hasAdmin ? adminPhrase.trim() : undefined,
      });
      deleteJobId.current = nextJob.jobId;
      setDeleteJob(nextJob);
      setDeleteProgress(undefined);
    } catch (removeError) {
      deletingIds.current = new Set();
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
  const copyDetail = async (value: string) => {
    try {
      await copyText(value);
      notify("Disalin ke clipboard.");
    } catch (copyError) {
      setError(messageOf(copyError));
    }
  };
  const exportReport = async (command: "export_cleanup_report" | "export_cleanup_metafile" | "export_cleanup_detail", openFile = false) => {
    setError(undefined);
    try {
      const result = await invoke<ActionReport>(command);
      notify(`Export dibuat: ${result.message}`);
      if (openFile) {
        try {
          await invoke<ActionReport>("open_exported_cleanup_file", { path: result.message });
        } catch (openError) {
          setError(`Export dibuat di ${result.message}, tetapi tidak bisa dibuka otomatis: ${messageOf(openError)}`);
        }
      }
    } catch (exportError) {
      setError(messageOf(exportError));
    }
  };

  useEffect(() => {
    setVisibleLimit(80);
  }, [query, riskFilter, decisionFilter, categoryFilter, sizeFilter, sort]);

  const summary = useMemo(() => report ? cleanupSummary(report) : undefined, [report]);
  const allItems = useMemo(() => report ? [...report.items, ...(report.advisories ?? [])] : [], [report]);
  const selectedItems = useMemo(() => allItems.filter((item) => selected.has(item.id)), [allItems, selected]);
  const selectedCleanItems = useMemo(() => selectedItems.filter((item) => decisionOf(item) === "clean"), [selectedItems]);
  const selectedAdminItems = useMemo(() => selectedItems.filter((item) => decisionOf(item) === "admin"), [selectedItems]);
  const selectedBytes = useMemo(() => selectedItems.reduce((sum, item) => sum + item.sizeBytes, 0), [selectedItems]);
  const selectedSkipped = useMemo(() => selectedItems.reduce((sum, item) => sum + item.skippedCount, 0), [selectedItems]);
  const filtered = useMemo(() => allItems
    .filter((item) => {
      const haystack = `${item.name ?? item.category} ${item.path} ${item.category} ${item.group ?? ""}`.toLowerCase();
      const minBytes = sizeFilter * 1024 * 1024;
      return haystack.includes(query.toLowerCase())
        && (riskFilter === "all" || item.riskLevel === riskFilter)
        && (decisionFilter === "all" || decisionOf(item) === decisionFilter)
        && (!categoryFilter || item.category === categoryFilter)
        && item.sizeBytes >= minBytes;
    })
    .sort((a, b) => {
      if (sort === "name") return (a.name ?? a.category).localeCompare(b.name ?? b.category);
      if (sort === "priority") return (b.priority ?? 0) - (a.priority ?? 0) || b.sizeBytes - a.sizeBytes;
      return b.sizeBytes - a.sizeBytes;
    }), [allItems, categoryFilter, decisionFilter, query, riskFilter, sizeFilter, sort]);
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
  const focusCleanupItem = (item: CleanupItem) => {
    setQuery("");
    setRiskFilter("all");
    setDecisionFilter("all");
    setCategoryFilter(item.category);
    setVisibleLimit((current) => Math.max(current, 120));
    setExpanded((current) => new Set(current).add(item.id));
  };

  return (
    <div className="feature-page clean-deep-page">
      <div className="page-title">
        <div>
          <h1>Deep Cleanup Report</h1>
          <p>{report ? statusText(report) : "Scan folder cache, folder sampah, dev artifact, advisory disk hog, dan target manual dalam satu laporan audit."}</p>
        </div>
        <div className="row-buttons">
          <div className="engine-switch cleanup-engine-switch" role="radiogroup" aria-label="Metode scan cleanup">
            {scanEngineOptions.map((option) => (
              <button
                aria-checked={scanEngine === option.id}
                className={scanEngine === option.id ? "active" : ""}
                disabled={loading || !!scanJob || !!deleteJob}
                key={option.id}
                onClick={() => setScanEngine(option.id)}
                role="radio"
                title={option.detail}
              >
                {option.label}
              </button>
            ))}
          </div>
          {report && <button className="button ghost" onClick={() => void exportReport("export_cleanup_detail", true)}><ButtonIcon icon={FolderOpen} />Buka Analyzer</button>}
          <button className="button primary" disabled={loading || !!deleteJob} onClick={scan}>
            <ButtonIcon icon={loading ? Loader2 : Search} />
            {loading ? "Memindai..." : "Pindai Deep Cleanup"}
          </button>
        </div>
      </div>
      <ErrorBanner message={error} />
      <div className="feature-strip cleanup-scope-strip">
        {cleanupScopes.map((group, index) => (
          <div className="scope-card" key={group.join("-")}>
            <strong>{["Temp", "Browser", "Developer", "App Cache", "Windows"][index]}</strong>
            <small>{group.join(" / ")}</small>
          </div>
        ))}
      </div>
      {scanEngine === "wiztree" && (
        <WizTreeStatusPanel
          status={wizTree.status}
          loading={wizTree.loading}
          installing={wizTree.installing}
          verifying={wizTree.verifying}
          error={wizTree.error}
          onRefresh={() => void wizTree.refresh()}
          onVerify={() => void wizTree.verify()}
          onInstall={() => void wizTree.install()}
        />
      )}
      {loading && (
        <ScanProgressPanel
          title={`Menganalisis folder cache dan sampah (${scanJob?.engine ?? scanEngineOptions.find((item) => item.id === scanEngine)?.label})`}
          detail={scanProgress?.currentPath ?? "LeoDisk sedang menghitung ukuran, akses terbatas, dan kandidat aman sebelum daftar ditampilkan."}
          phase={scanProgress?.phase ?? (scanEngine === "wiztree" ? "Menyiapkan proses WizTree" : "Membaca struktur folder")}
          stats={[
            ["Proses", scanProgress?.phase ?? "Memulai"],
            ["Durasi", formatElapsed(scanProgress?.elapsedMs)],
            ["Root", scanProgress?.rootsScanned ?? 0],
            ["Folder", scanProgress?.foldersScanned ?? 0],
            ["File", scanProgress?.filesScanned ?? 0],
            ["Ukuran", formatBytes(scanProgress?.bytesScanned)],
            ["Skipped", scanProgress?.skippedCount ?? 0],
          ]}
          action={scanJob && <button className="button ghost compact" onClick={() => void cancelScan()}><ButtonIcon icon={X} />Batalkan</button>}
        />
      )}
      {deleteJob && (
        <ScanProgressPanel
          title="Membersihkan item terpilih"
          detail={deleteProgress?.currentPath ?? "LeoDisk sedang memindahkan atau menghapus item terpilih di background."}
          value={deleteProgress?.totalItems ? Math.round((deleteProgress.processedItems / deleteProgress.totalItems) * 100) : undefined}
          stats={[
            ["Selesai", `${deleteProgress?.processedItems ?? 0}/${deleteProgress?.totalItems ?? deletingIds.current.size}`],
            ["Dihapus", deleteProgress?.affectedCount ?? 0],
            ["Bersih", formatBytes(deleteProgress?.reclaimedBytes)],
            ["Skipped", deleteProgress?.skippedCount ?? 0],
          ]}
        />
      )}
      {!report && !loading && <Panel><EmptyState>Mulai pemindaian untuk melihat folder cache, Windows Temp, dev cache, shader cache, Downloads review, dan advisory disk hog.</EmptyState></Panel>}
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
              <span><strong>{report.scanEngine ?? "Native"}</strong>Engine Scan</span>
              {report.cachePath && <span><strong>CSV Cache</strong>{report.cachePath}</span>}
            </div>
            <div className="panel-actions">
              <span>Export audit tanpa scan ulang</span>
              <button className="button ghost compact" onClick={() => void exportReport("export_cleanup_metafile")}><ButtonIcon icon={Database} />Export Metafile</button>
              <button className="button ghost compact" onClick={() => void exportReport("export_cleanup_report")}><ButtonIcon icon={Download} />Export Cleanup Report</button>
              <button className="button ghost compact" onClick={() => void exportReport("export_cleanup_detail")}><ButtonIcon icon={FileSearch} />Export Laporan Detail</button>
            </div>
          </Panel>
          <div className="summary-cards cleanup-scorecards">
            <Panel title="TOTAL SAMPAH" accent="amber"><div className="metric">{formatBytes(summary?.totalJunkBytes)}</div><p className="muted">{report.totalFiles} file</p></Panel>
            <Panel title="SIAP DIBERSIHKAN" accent="mint"><div className="metric">{formatBytes(summary?.cleanableBytes)}</div><p className="muted">{summary?.cleanableItems} item</p></Panel>
            <Panel title="PERLU REVIEW" accent="blue"><div className="metric">{summary?.reviewItems}</div><p className="muted">{formatBytes(summary?.reviewBytes)}</p></Panel>
            <Panel title="MANUAL / TERTAHAN" accent="amber"><div className="metric">{summary?.manualItems}</div><p className="muted">{formatBytes(summary?.manualBytes)}</p></Panel>
            <Panel title="ADMIN CLEAN" accent="amber"><div className="metric">{summary?.adminItems ?? 0}</div><p className="muted">{formatBytes(summary?.adminBytes ?? 0)}</p></Panel>
            <Panel title="DISK HOG ADVISORY" accent="blue"><div className="metric">{formatBytes(summary?.advisoryBytes)}</div><p className="muted">{summary?.advisoryItems} temuan</p></Panel>
          </div>
          <CleanupCharts
            report={report}
            selectedCategory={categoryFilter}
            onSelectCategory={(category) => setCategoryFilter((current) => current === category ? "" : category)}
          />
          <CleanupItemGraph
            items={allItems}
            onFocus={focusCleanupItem}
            onOpen={openLocation}
          />
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
                      <button className="button ghost compact" onClick={() => selectIds([item.id])}><ButtonIcon icon={Check} />Pilih</button>
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
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari nama file/folder, path, atau kategori..." />
              <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as typeof riskFilter)}>
                <option value="all">Semua Risiko</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <select value={decisionFilter} onChange={(event) => setDecisionFilter(event.target.value as typeof decisionFilter)}>
                <option value="all">Semua Keputusan</option>
                <option value="clean">Clean</option>
                <option value="admin">Admin Clean</option>
                <option value="review">Review</option>
                <option value="manual">Manual</option>
                <option value="advisory">Advisory</option>
              </select>
              <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option value="">Semua Kategori</option>
                {(report.categoryTotals ?? []).map((item) => (
                  <option key={`${item.group}-${item.category}`} value={item.category}>{item.category}</option>
                ))}
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
            <p className="protected-note">Clean biasa bisa dipilih langsung. Admin Clean harus diizinkan manual, lalu tetap membutuhkan phrase konfirmasi saat hapus.</p>
            {categoryFilter && (
              <button className="filter-chip" onClick={() => setCategoryFilter("")}>
                <X size={14} aria-hidden="true" /> Filter kategori: {categoryFilter}
              </button>
            )}
            <div className="deep-cleanup-list">
              {visibleItems.map((item) => {
                const decision = decisionOf(item);
                const isAdmin = decision === "admin";
                const selectable = decision === "clean" || (isAdmin && adminUnlocked.has(item.id));
                const isReviewed = reviewed.has(item.id);
                const isExpanded = expanded.has(item.id);
                return (
                  <article className={`deep-cleanup-row ${decision} ${isReviewed ? "reviewed" : ""}`} key={item.id}>
                    <input
                      aria-label={`Pilih ${item.name ?? item.category}`}
                      type="checkbox"
                      disabled={!selectable || !!deleteJob}
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
                      <small className="cleanup-meta">{item.scope ?? "User-level"} - {item.detectedBy ?? "Known path"} - {item.confidenceLabel ?? "Reviewed"}</small>
                      {item.blockedReason && <small className="safety review">{item.blockedReason}</small>}
                      {isReviewed && <small className="safety safe">Sudah dicek manual</small>}
                    </span>
                    <span className="mono">{formatBytes(item.sizeBytes)}</span>
                    <span className="mono">{item.fileCount} file</span>
                    <div className="row-actions">
                      <button className="text-action" onClick={() => toggleExpanded(item.id)}>{isExpanded ? "Tutup" : "Detail"}</button>
                      {isAdmin && !adminUnlocked.has(item.id) && <button className="text-action warning" onClick={() => setAdminUnlocked((current) => new Set(current).add(item.id))}>Izinkan</button>}
                      {!selectable && !isAdmin && <button className="text-action" onClick={() => markReviewed(item.id)}>Cek</button>}
                      <button className="text-action" onClick={() => void openLocation(item.id)}>Buka</button>
                    </div>
                    {isExpanded && (
                      <CleanupEvidenceCard
                        item={item}
                        selectable={selectable}
                        adminApproved={adminUnlocked.has(item.id)}
                        onApproveAdmin={() => setAdminUnlocked((current) => new Set(current).add(item.id))}
                        onOpen={() => void openLocation(item.id)}
                        onCopy={(value) => void copyDetail(value)}
                      />
                    )}
                  </article>
                );
              })}
              {!filtered.length && <EmptyState>Tidak ada item sesuai filter.</EmptyState>}
              {visibleItems.length < filtered.length && (
                <button className="button ghost load-more" onClick={() => setVisibleLimit((current) => current + 80)}>
                  <ButtonIcon icon={ChevronUp} />
                  Tampilkan 80 lagi
                </button>
              )}
            </div>
            <div className="panel-actions">
              <span>{selectedCleanItems.length} clean + {selectedAdminItems.length} admin dipilih - {formatBytes(selectedBytes)} - {reviewed.size} sudah dicek</span>
              <button className="button ghost compact" disabled={!cleanIds.length || !!deleteJob} onClick={() => selectIds(cleanIds)}><ButtonIcon icon={ShieldCheck} />Pilih semua Clean</button>
              <button className="button ghost compact" disabled={!filteredCleanIds.length || !!deleteJob} onClick={() => selectIds(filteredCleanIds)}><ButtonIcon icon={Check} />Pilih Clean terfilter</button>
              <button className="button ghost compact" disabled={!selected.size || !!deleteJob} onClick={() => setSelected(new Set())}><ButtonIcon icon={X} />Unselect all</button>
              <button className="button danger" disabled={!selected.size || !!deleteJob || loading} onClick={() => {
                setAdminPhrase("");
                setConfirming(true);
              }}>
                <ButtonIcon icon={Trash2} />
                {deleteJob ? "Menghapus..." : "Hapus item terpilih"}
              </button>
            </div>
          </Panel>
        </>
      )}
      {confirming && (
        <CleanupConfirmDialog
          cleanCount={selectedCleanItems.length}
          adminCount={selectedAdminItems.length}
          totalBytes={selectedBytes}
          skippedCount={selectedSkipped}
          phrase={adminPhrase}
          onPhraseChange={setAdminPhrase}
          onCancel={() => setConfirming(false)}
          onRecycle={() => void remove(false)}
          onPermanent={() => void remove(true)}
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
      {loading && (
        <ScanProgressPanel
          title={loading === "installers" ? "Mencari installer besar" : loading === "folder" ? "Memindai folder proyek" : "Mencari artefak proyek"}
          detail="LeoDisk sedang menghitung dependency, build output, virtualenv, cache proyek, dan kandidat installer."
          stats={[["Mode", loading], ["Status", "Memindai"]]}
        />
      )}
      {!report && !loading && (
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
      <div className="feature-strip remnant-scope-strip">
        {remnantScopes.map((group) => (
          <div className="scope-card" key={group.join("-")}>
            <strong>{group[0]}</strong>
            <small>{group.slice(1).join(" / ")}</small>
          </div>
        ))}
      </div>
      <ErrorBanner message={error} />
      {(loading || remnantsLoading || measuring) && (
        <ScanProgressPanel
          title={loading ? "Memuat daftar aplikasi" : remnantsLoading ? "Mencari sisa uninstall" : "Mengukur folder instalasi"}
          detail={loading ? "LeoDisk membaca registry uninstall Windows." : remnantsLoading ? "Memeriksa AppData, ProgramData, cache, logs, config, dan extension/plugin." : "Menghitung ukuran folder aplikasi dan file yang tidak bisa dibaca."}
          stats={[["Aplikasi", selectedApp?.name ?? "Semua"], ["Status", loading ? "Memuat" : "Memindai"]]}
        />
      )}
      <div className="apps-layout">
        <section className="apps-list">
          {loading && <EmptyState>Menyiapkan daftar aplikasi...</EmptyState>}
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

type CleanupStatus = {
  scanJob?: ScanJob;
  scanProgress?: CleanupScanProgress;
  deleteJob?: ScanJob;
  deleteProgress?: CleanupDeleteProgress;
  error?: string;
};

function fileCategoryLabel(path: string) {
  const lower = path.toLowerCase();
  if (/\.(mp4|mkv|mov|avi|webm|wmv)$/.test(lower)) return "Video";
  if (/\.(png|jpg|jpeg|gif|webp|psd|svg|heic)$/.test(lower)) return "Gambar";
  if (/\.(mp3|wav|flac|aac|ogg)$/.test(lower)) return "Audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md)$/.test(lower)) return "Dokumen";
  if (/\.(zip|rar|7z|msi|exe|iso|tar|gz)$/.test(lower)) return "Arsip & installer";
  if (lower.includes("\\appdata\\") || lower.includes("/appdata/") || lower.includes("cache")) return "Data aplikasi/cache";
  return "Lainnya";
}

function samePath(left?: string, right?: string) {
  return (left ?? "").replace(/[\\/]+$/, "").toLowerCase() === (right ?? "").replace(/[\\/]+$/, "").toLowerCase();
}

function childFoldersFor(result: DiskScanResult, root: string) {
  const source = result.allFolders?.length ? result.allFolders : result.folders;
  return source
    .filter((folder) => samePath(folder.parentPath, root))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 250);
}

function StorageCategoryChart({
  result,
  selected,
  onSelect,
}: {
  result: DiskScanResult;
  selected: string;
  onSelect: (category: string) => void;
}) {
  const data = result.categories.map((item) => ({ name: item.label, value: item.sizeBytes, files: item.fileCount }));
  return (
    <Panel title="GRAFIK STORAGE" accent="blue" tag={selected || "Semua kategori"}>
      <div className="storage-chart-layout">
        <div className="chart-box compact-chart">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={180}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={48} outerRadius={84} paddingAngle={3}>
                {data.map((entry, index) => (
                  <Cell key={entry.name} fill={entry.name === selected ? "#f2ede4" : CHART_COLORS[index % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<ByteTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="category-grid chart-category-grid">
          {result.categories.map((category, index) => (
            <button
              className={`category-card ${category.colorKey} ${selected === category.label ? "active" : ""}`}
              key={category.label}
              onClick={() => onSelect(selected === category.label ? "" : category.label)}
            >
              <span>{category.label}</span>
              <strong>{formatBytes(category.sizeBytes)}</strong>
              <small>{category.fileCount} file</small>
              <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function FolderSizeGraph({
  folders,
  onFocus,
  onOpen,
}: {
  folders: DiskFolder[];
  onFocus: (folder: DiskFolder) => void;
  onOpen: (locationId: string) => void;
}) {
  const topFolders = folders.slice(0, 12);
  const maxSize = Math.max(...topFolders.map((folder) => folder.sizeBytes), 1);
  return (
    <Panel title="GRAPH FOLDER INTERAKTIF" accent="amber" tag={`${topFolders.length} folder terbesar`}>
      <div className="folder-graph">
        {topFolders.map((folder, index) => {
          const percent = Math.max(4, (folder.sizeBytes / maxSize) * 100);
          return (
            <article className="folder-graph-row" key={folder.path}>
              <button
                className="folder-graph-track"
                onClick={() => onFocus(folder)}
                style={{ "--bar": `${percent}%` } as CSSProperties}
              >
                <span className="folder-graph-rank">{String(index + 1).padStart(2, "0")}</span>
                <span className="folder-graph-name">
                  <strong>{folder.name}</strong>
                  <small>{folder.parentPath || folder.path}</small>
                </span>
                <span className="folder-graph-size">
                  <strong>{formatBytes(folder.sizeBytes)}</strong>
                  <small>{folder.fileCount} file</small>
                </span>
              </button>
              <button className="text-action folder-graph-open" onClick={() => onOpen(folder.locationId)}>
                Buka
              </button>
            </article>
          );
        })}
        {!topFolders.length && <EmptyState>Belum ada folder besar yang bisa dibuat graph.</EmptyState>}
      </div>
    </Panel>
  );
}

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
  const [scanEngine, setScanEngine] = useState<DiskScanEngineId>("native");
  const [analyzerTabs, setAnalyzerTabs] = useState(defaultAnalyzerTabs);
  const [analyzerTab, setAnalyzerTab] = useState(defaultAnalyzerTabs[0].id);
  const [storageCategoryFilter, setStorageCategoryFilter] = useState("");
  const [droppedReviewFiles, setDroppedReviewFiles] = useState<string[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const wizTree = useWizTreeTools(notify);
  const activeJobId = useRef<string | undefined>(undefined);
  const acceptingStartEvents = useRef(false);
  const pendingProgress = useRef<DiskScanProgress | undefined>(undefined);
  const pendingResult = useRef<DiskScanResult | undefined>(undefined);
  const pendingError = useRef<{ jobId: string; message: string } | undefined>(undefined);
  const startFromDrop = useRef<(root: string) => void>(() => {});
  const readPendingResult = () => pendingResult.current;
  const readPendingError = () => pendingError.current;
  const readPendingProgress = () => pendingProgress.current;
  const sortableSensors = useSortableSensors();

  useEffect(() => {
    onScanStatus({ job, progress, error });
  }, [job, progress, error, onScanStatus]);

  const completeScan = (payload: DiskScanResult) => {
    setResult(payload);
    setProgress(undefined);
    setJob(undefined);
    activeJobId.current = undefined;
    setSelected(new Set());
    setStorageCategoryFilter("");
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
    void getCurrentWebview().onDragDropEvent((event) => {
      if (!mounted) return;
      const payload = event.payload as { type?: string; paths?: string[] };
      if (payload.type === "over") {
        setDropActive(true);
        return;
      }
      if (payload.type === "cancel") {
        setDropActive(false);
        return;
      }
      if (payload.type !== "drop") return;
      setDropActive(false);
      const paths = payload.paths ?? [];
      const fileLike = paths.filter((path) => /\.[a-z0-9]{1,8}$/i.test(path));
      const folderLike = paths.find((path) => !fileLike.includes(path));
      if (fileLike.length) {
        setDroppedReviewFiles((current) => [...fileLike, ...current].slice(0, 20));
        setAnalyzerTab("review");
        notify(`${fileLike.length} file masuk Review Queue.`);
      }
      if (folderLike) {
        setAnalyzerTab("report");
        startFromDrop.current(folderLike);
      }
    }).then((unlisten) => {
      if (!mounted) unlisten();
    }).catch(() => {});
    return () => {
      mounted = false;
    };
  }, [notify]);

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
      const nextJob = await invoke<ScanJob>("start_disk_scan", { root, scanEngine });
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
  startFromDrop.current = (root: string) => {
    void start(root);
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
    const existingIndex = result.breadcrumbs.findIndex((crumb) => samePath(crumb.path, folder.path));
    const breadcrumbs = existingIndex >= 0
      ? result.breadcrumbs.slice(0, existingIndex + 1)
      : [...result.breadcrumbs, { locationId: folder.locationId, label: folder.name, path: folder.path }];
    setResult({
      ...result,
      root: folder.path,
      rootLocationId: folder.locationId,
      breadcrumbs,
      parentLocation: breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2] : undefined,
      totalBytes: folder.sizeBytes,
      fileCount: folder.fileCount,
      folders: childFoldersFor(result, folder.path),
      largestFiles: result.largestFiles.filter((file) => file.path.toLowerCase().startsWith(folder.path.toLowerCase())),
    });
    setSelected(new Set());
  };
  const goBackFolder = () => {
    if (!result?.parentLocation) return;
    const folder = (result.allFolders ?? result.folders).find((item) => samePath(item.path, result.parentLocation?.path));
    if (folder) {
      focusFolder(folder);
      return;
    }
    setResult({
      ...result,
      root: result.parentLocation.path,
      rootLocationId: result.parentLocation.locationId,
      breadcrumbs: result.breadcrumbs.slice(0, -1),
      parentLocation: result.breadcrumbs.length > 2 ? result.breadcrumbs[result.breadcrumbs.length - 3] : undefined,
      folders: childFoldersFor(result, result.parentLocation.path),
    });
  };
  const goToCachedBreadcrumb = (index: number) => {
    const target = result?.breadcrumbs[index];
    if (!target || !result) return;
    const folder = (result.allFolders ?? result.folders).find((item) => samePath(item.path, target.path));
    if (folder) {
      focusFolder(folder);
      return;
    }
    setResult({
      ...result,
      root: target.path,
      rootLocationId: target.locationId,
      breadcrumbs: result.breadcrumbs.slice(0, index + 1),
      parentLocation: index > 0 ? result.breadcrumbs[index - 1] : undefined,
      folders: childFoldersFor(result, target.path),
    });
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
  const filteredLargeFiles = result?.largestFiles.filter((file) => !storageCategoryFilter || fileCategoryLabel(file.path) === storageCategoryFilter) ?? [];
  const handleAnalyzerDragEnd = (event: DragEndEvent) => {
    const { active: activeItem, over } = event;
    if (!over || activeItem.id === over.id) return;
    setAnalyzerTabs((current) => {
      const oldIndex = current.findIndex((item) => item.id === activeItem.id);
      const newIndex = current.findIndex((item) => item.id === over.id);
      return oldIndex >= 0 && newIndex >= 0 ? arrayMove(current, oldIndex, newIndex) : current;
    });
  };
  return (
    <div className={`feature-page analyze-page ${dropActive ? "drop-active" : ""}`}>
      <div className="analyze-toolbar">
        <div className="breadcrumbs">
          <button disabled={busy} onClick={() => setResult(undefined)}>Drive</button>
          {result?.breadcrumbs.map((crumb) => (
            <span className="breadcrumb-item" key={crumb.locationId}>
              <span>/</span>
              <button disabled={busy || crumb.path === result.root} onClick={() => goToCachedBreadcrumb(result.breadcrumbs.findIndex((item) => item.locationId === crumb.locationId))}>{crumb.label}</button>
            </span>
          ))}
        </div>
        <div className="engine-switch" role="radiogroup" aria-label="Metode scan">
          {scanEngineOptions.map((option) => (
            <button
              aria-checked={scanEngine === option.id}
              className={scanEngine === option.id ? "active" : ""}
              disabled={busy}
              key={option.id}
              onClick={() => setScanEngine(option.id)}
              role="radio"
              title={option.detail}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="row-buttons">
          <button className="button ghost" disabled={busy || !listenersReady} onClick={() => void choose()}>Pilih lokasi</button>
          {result && <button className="button ghost" onClick={() => void openLocation(result.rootLocationId)}>Buka root</button>}
          {job && <button className="button danger" onClick={() => void cancel()}>Batalkan</button>}
        </div>
      </div>
      {scanEngine === "wiztree" && (
        <WizTreeStatusPanel
          status={wizTree.status}
          loading={wizTree.loading}
          installing={wizTree.installing}
          verifying={wizTree.verifying}
          error={wizTree.error}
          onRefresh={() => void wizTree.refresh()}
          onVerify={() => void wizTree.verify()}
          onInstall={() => void wizTree.install()}
        />
      )}
      <ErrorBanner message={error} />
      {dropActive && (
        <div className="drop-overlay" role="status">
          <FolderOpen size={28} aria-hidden="true" />
          <strong>Lepaskan folder untuk scan atau file untuk review</strong>
        </div>
      )}
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
        <ScanProgressPanel
          title={`Membangun peta ukuran folder (${job.engine})`}
          detail={progress?.currentPath || job.root}
          stats={[
            ["Terbaca", formatBytes(progress?.bytesScanned ?? 0)],
            ["File", progress?.filesScanned ?? 0],
            ["Folder", progress?.foldersScanned ?? 0],
            ["Dilewati", progress?.inaccessible ?? 0],
          ]}
        />
      )}
      {result && (
        <>
          <Panel title="ANALYZER STORAGE" accent="blue" tag="folder-size map">
            <div className="analyzer-summary">
              <span><strong>{formatBytes(result.totalBytes)}</strong>Total Terindeks</span>
              <span><strong>{formatBytes(result.categories.find((item) => item.label.includes("Data aplikasi"))?.sizeBytes ?? 0)}</strong>Cleanable</span>
              <span><strong>{formatBytes(result.categories.find((item) => item.label.includes("Dokumen"))?.sizeBytes ?? 0)}</strong>Personal Data</span>
              <span><strong>{formatBytes(result.largestFiles.reduce((sum, file) => sum + file.sizeBytes, 0))}</strong>Large Files</span>
              <span><strong>{result.folders.length}</strong>Node Tertangkap</span>
              <span><strong>{result.engine}</strong>Engine Scan</span>
              {result.cachePath && <span><strong>CSV Cache</strong>{result.cachePath}</span>}
              <span><strong>{volumes.length}</strong>Volumes</span>
              <span><strong>{result.inaccessible}</strong>Inaccessible</span>
            </div>
            <div className="analyzer-tabs">
              <DndContext sensors={sortableSensors} collisionDetection={closestCenter} onDragEnd={handleAnalyzerDragEnd}>
                <SortableContext items={analyzerTabs.map((item) => item.id)} strategy={horizontalListSortingStrategy}>
                  {analyzerTabs.map((item) => (
                    <SortableTabButton
                      className="analyzer-tab-button"
                      active={analyzerTab === item.id}
                      icon={item.icon}
                      id={item.id}
                      key={item.id}
                      label={item.label}
                      onClick={() => setAnalyzerTab(item.id)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
            </div>
          </Panel>
          <FolderSizeGraph folders={result.folders} onFocus={focusFolder} onOpen={openLocation} />
          <div className="analyze-layout">
            <aside className="disk-sidebar">
              <div className="disk-orb" />
              <div className="disk-total">
                <strong>{formatBytes(result.totalBytes)}</strong>
                <span>{result.fileCount} file - {result.inaccessible} dilewati</span>
              </div>
              {result.parentLocation && (
                <button className="folder-item parent" disabled={busy} onClick={goBackFolder}>
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
          <StorageCategoryChart
            result={result}
            selected={storageCategoryFilter}
            onSelect={setStorageCategoryFilter}
          />
          <Panel title="PENYEBAB PENGGUNAAN RUANG" accent="mint" tag={`${result.categories.length} kategori`}>
            <div className="category-grid">
              {result.categories.map((category) => (
                <button className={`category-card ${category.colorKey} ${storageCategoryFilter === category.label ? "active" : ""}`} key={category.label} onClick={() => setStorageCategoryFilter((current) => current === category.label ? "" : category.label)}>
                  <span>{category.label}</span>
                  <strong>{formatBytes(category.sizeBytes)}</strong>
                  <small>{category.fileCount} file</small>
                </button>
              ))}
            </div>
            {!!result.inaccessible && (
              <p className="protected-note">
                {result.inaccessible} lokasi terlindungi atau reparse point dilewati. Gunakan Rekomendasi pembersihan Windows untuk area sistem.
              </p>
            )}
          </Panel>
          <Panel title="FILE BESAR - PERIKSA SEBELUM DIHAPUS (MIN. 100 MB)" accent="amber" tag={`${filteredLargeFiles.length} file`}>
            {storageCategoryFilter && (
              <button className="filter-chip" onClick={() => setStorageCategoryFilter("")}>
                <X size={14} aria-hidden="true" /> Filter storage: {storageCategoryFilter}
              </button>
            )}
            <div className="large-files-list">
            {filteredLargeFiles.map((file) => (
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
            {!filteredLargeFiles.length && <EmptyState>Tidak ditemukan file di atas 100 MB untuk filter ini.</EmptyState>}
            {!!filteredLargeFiles.length && (
              <div className="panel-actions">
                <span>{selected.size} file dipilih - file besar tidak otomatis aman dihapus</span>
                <button className="button danger" disabled={!selected.size} onClick={() => setConfirming(true)}>Hapus file dipilih</button>
              </div>
            )}
          </Panel>
          <Panel title="REVIEW QUEUE DROP" accent="blue" tag={`${droppedReviewFiles.length} file manual`}>
            <div className="drop-review-list">
              {droppedReviewFiles.map((path) => (
                <article className="drop-review-item" key={path}>
                  <FileSearch size={18} aria-hidden="true" />
                  <span>
                    <strong>{path.split(/[\\/]/).pop() || path}</strong>
                    <small>{path}</small>
                  </span>
                  <b>{fileCategoryLabel(path)}</b>
                </article>
              ))}
              {!droppedReviewFiles.length && <EmptyState>Drag file dari Explorer ke LeoDisk untuk memasukkannya ke antrean review manual.</EmptyState>}
            </div>
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
  const [navTabs, setNavTabs] = useState(defaultTabs);
  const [latestCleanup, setLatestCleanup] = useState<CleanupReport>();
  const [toast, setToast] = useState<string>();
  const [scanStatus, setScanStatus] = useState<ScanStatus>({});
  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus>({});
  const currentLabel = useMemo(() => navTabs.find((item) => item.id === tab)?.label, [navTabs, tab]);
  const sortableSensors = useSortableSensors();
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
  const cancelActiveCleanupScan = async () => {
    if (!cleanupStatus.scanJob) return;
    try {
      const report = await invoke<ActionReport>("cancel_cleanup_scan", { jobId: cleanupStatus.scanJob.jobId });
      notify(report.message);
    } catch (cancelError) {
      notify(messageOf(cancelError));
    }
  };
  const handleNavDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setNavTabs((current) => {
      const oldIndex = current.findIndex((item) => item.id === active.id);
      const newIndex = current.findIndex((item) => item.id === over.id);
      return oldIndex >= 0 && newIndex >= 0 ? arrayMove(current, oldIndex, newIndex) : current;
    });
  };

  return (
    <AppErrorBoundary>
      <main className="app-shell">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">L</span><strong>LeoDisk</strong></div>
          <nav className="nav-pill" aria-label="Navigasi utama">
            <DndContext sensors={sortableSensors} collisionDetection={closestCenter} onDragEnd={handleNavDragEnd}>
              <SortableContext items={navTabs.map((item) => item.id)} strategy={horizontalListSortingStrategy}>
                {navTabs.map((item) => (
                  <SortableTabButton
                    active={tab === item.id}
                    icon={item.icon}
                    id={item.id}
                    key={item.id}
                    label={item.label}
                    onClick={() => setTab(item.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </nav>
          <div className="topbar-status">
            <span className="current-tab">{currentLabel}</span>
            {scanStatus.job && (
              <div className="scan-chip" role="status">
                <button className="text-action" onClick={() => setTab("analyze")}>Scan: {scanStatus.job.root}</button>
                <span>{scanStatus.job.engine} - {scanStatus.progress?.filesScanned ?? 0} file</span>
                <button className="text-action" onClick={() => void cancelActiveScan()}>Batalkan</button>
              </div>
            )}
            {(cleanupStatus.scanJob || cleanupStatus.deleteJob) && (
              <div className="scan-chip cleanup-chip" role="status">
                <button className="text-action" onClick={() => setTab("clean")}>
                  {cleanupStatus.deleteJob ? "Clean: menghapus" : "Clean: scan"}
                </button>
                <span>
                  {cleanupStatus.deleteJob
                    ? `${cleanupStatus.deleteProgress?.processedItems ?? 0}/${cleanupStatus.deleteProgress?.totalItems ?? 0} item`
                    : `${cleanupStatus.scanProgress?.filesScanned ?? 0} file`}
                </span>
                {cleanupStatus.scanJob && <button className="text-action" onClick={() => void cancelActiveCleanupScan()}>Batalkan</button>}
              </div>
            )}
          </div>
        </header>
        <div className="workspace">
          {tab === "status" && <StatusPage active latestCleanup={latestCleanup} />}
          <div hidden={tab !== "clean"}>
            <CleanPage onReport={setLatestCleanup} onStatus={setCleanupStatus} notify={notify} />
          </div>
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
