import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  formatBytes,
  formatPercent,
  Panel,
  ProgressBar,
  Sparkline,
  Toast,
} from "./components";
import type {
  ActionReport,
  AppSizeMeasurement,
  CleanupReport,
  DiskScanProgress,
  DiskScanResult,
  InstalledApp,
  ScanJob,
  StorageVolume,
  StartupItem,
  SystemSnapshot,
  Tab,
} from "./types";
import "./App.css";

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "clean", label: "Bersihkan" },
  { id: "apps", label: "Aplikasi" },
  { id: "optimize", label: "Optimalkan" },
  { id: "analyze", label: "Analisis" },
  { id: "status", label: "Status" },
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

function StatusPage({
  active,
  latestCleanup,
}: {
  active: boolean;
  latestCleanup?: CleanupReport;
}) {
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
        setCpuHistory((history) => [...history.slice(-25), data.cpuPercent]);
        setNetworkHistory((history) => [...history.slice(-25), data.networkDownPerSec]);
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
          <div className="metric">{snapshot ? formatPercent((snapshot.memoryUsed / snapshot.memoryTotal) * 100) : "--"}</div>
          <ProgressBar
            value={snapshot ? (snapshot.memoryUsed / snapshot.memoryTotal) * 100 : 0}
            accent="amber"
          />
          <p className="muted">
            {snapshot ? `${formatBytes(snapshot.memoryUsed)} / ${formatBytes(snapshot.memoryTotal)}` : "Memuat..."}
          </p>
        </Panel>
        <Panel title="GPU" accent="amber">
          <div className="metric">{formatPercent(snapshot?.gpuPercent)}</div>
          <p className="muted">
            {snapshot?.gpuPercent === undefined
              ? "Counter GPU tidak tersedia"
              : "Utilisasi GPU Windows"}
          </p>
        </Panel>
        <Panel title="DISK" accent="blue" className="wide-card">
          <div className="metric">{snapshot ? formatBytes(snapshot.diskTotal - snapshot.diskUsed) : "--"} <small>tersedia</small></div>
          <ProgressBar
            value={snapshot ? (snapshot.diskUsed / snapshot.diskTotal) * 100 : 0}
            accent="blue"
          />
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

function CleanPage({
  onReport,
  notify,
}: {
  onReport: (report: CleanupReport) => void;
  notify: (message: string) => void;
}) {
  const [report, setReport] = useState<CleanupReport>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const scan = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await invoke<CleanupReport>("scan_cleanup");
      setReport(result);
      setSelected(new Set(result.items.filter((item) => item.safeToDelete).map((item) => item.id)));
      onReport(result);
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
      await scan();
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

  return (
    <div className="feature-page">
      <div className="page-title">
        <div>
          <h1>Bersihkan cache aman</h1>
          <p>Cache aman ditandai jelas. Pilih Recycle Bin atau hapus permanen hanya setelah konfirmasi.</p>
        </div>
        <button className="button primary" disabled={loading} onClick={scan}>
          {loading ? "Memindai..." : "Pindai sekarang"}
        </button>
      </div>
      <ErrorBanner message={error} />
      {!report && <Panel><EmptyState>Mulai pemindaian untuk menemukan cache Edge, Chrome, Brave, Firefox, temp, dan crash dump.</EmptyState></Panel>}
      {report && (
        <>
          <div className="summary-cards">
            <Panel title="DAPAT DIBERSIHKAN" accent="mint"><div className="metric">{formatBytes(report.totalBytes)}</div></Panel>
            <Panel title="FILE" accent="blue"><div className="metric">{report.totalFiles}</div></Panel>
            <Panel title="DILEWATI" accent="amber"><div className="metric">{report.skippedCount}</div></Panel>
          </div>
          <Panel>
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
              <EmptyState>Tidak ada cache aman yang ditemukan.</EmptyState>
            )}
            <div className="panel-actions">
              <span>{selected.size} lokasi dipilih</span>
              <button className="button danger" disabled={!selected.size} onClick={() => setConfirming(true)}>
                Hapus item terpilih
              </button>
            </div>
          </Panel>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Bersihkan item terpilih?"
          description="Item berlabel Aman dihapus adalah cache sementara. Pilih Recycle Bin untuk dapat memulihkan file, atau Hapus permanen jika Anda yakin."
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

function AnalyzePage({ active, notify }: { active: boolean; notify: (message: string) => void }) {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [loadingVolumes, setLoadingVolumes] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [startingScan, setStartingScan] = useState(false);
  const [job, setJob] = useState<ScanJob>();
  const [progress, setProgress] = useState<DiskScanProgress>();
  const [result, setResult] = useState<DiskScanResult>();
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

  const completeScan = (payload: DiskScanResult) => {
    setResult(payload);
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
    if (!active) return;
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
    return () => {
      mounted = false;
      setListenersReady(false);
      void handlers.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()));
    };
  }, [active]);

  const start = async (root: string) => {
    if (job || startingScan || !listenersReady) return;
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
  return (
    <div className="feature-page analyze-page">
      <div className="analyze-toolbar">
        <div className="breadcrumbs">
          <button disabled={busy} onClick={() => setResult(undefined)}>Drive</button>
          {result?.breadcrumbs.map((crumb) => (
            <span className="breadcrumb-item" key={crumb.locationId}>
              <span>/</span>
              <button disabled={busy} onClick={() => void start(crumb.path)}>{crumb.label}</button>
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
          <div className="analyze-layout">
            <aside className="disk-sidebar">
              <div className="disk-orb" />
              <div className="disk-total">
                <strong>{formatBytes(result.totalBytes)}</strong>
                <span>{result.fileCount} file - {result.inaccessible} dilewati</span>
              </div>
              {result.parentLocation && (
                <button className="folder-item parent" disabled={busy} onClick={() => void start(result.parentLocation!.path)}>
                  <span>Naik satu folder</span>
                </button>
              )}
              {result.folders.slice(0, 12).map((folder) => (
                <div className="folder-item" key={folder.path}>
                  <button disabled={busy} onClick={() => void start(folder.path)}>
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
                    onClick={() => void start(folder.path)}
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
  const currentLabel = useMemo(() => tabs.find((item) => item.id === tab)?.label, [tab]);
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 4000);
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
                {item.label}
              </button>
            ))}
          </nav>
          <span className="current-tab">{currentLabel}</span>
        </header>
        <div className="workspace">
          {tab === "status" && <StatusPage active latestCleanup={latestCleanup} />}
          {tab === "clean" && <CleanPage onReport={setLatestCleanup} notify={notify} />}
          {tab === "apps" && <AppsPage active notify={notify} />}
          {tab === "optimize" && <OptimizePage active notify={notify} />}
          {tab === "analyze" && <AnalyzePage active notify={notify} />}
        </div>
        {toast && <Toast message={toast} onClose={() => setToast(undefined)} />}
      </main>
    </AppErrorBoundary>
  );
}

export default App;
