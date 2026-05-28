import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const { invoke, listeners, dragDropHandlers } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  dragDropHandlers: [] as Array<(event: { payload: unknown }) => void>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation((eventName: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(eventName, callback);
    return Promise.resolve(() => listeners.delete(eventName));
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockImplementation((callback: (event: { payload: unknown }) => void) => {
      dragDropHandlers.push(callback);
      return Promise.resolve(() => {
        const index = dragDropHandlers.indexOf(callback);
        if (index >= 0) dragDropHandlers.splice(index, 1);
      });
    }),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn().mockResolvedValue(undefined),
}));

afterEach(cleanup);

beforeEach(() => {
  listeners.clear();
  dragDropHandlers.length = 0;
  invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === "get_system_snapshot") {
      return Promise.resolve({
        computerName: "PC-TEST",
        osLabel: "Windows 11",
        cpuPercent: 12,
        memoryUsed: 4_000,
        memoryTotal: 8_000,
        diskUsed: 50_000,
        diskTotal: 100_000,
        networkDownPerSec: 0,
        networkUpPerSec: 0,
        uptimeSeconds: 3600,
        processes: [],
      });
    }
    if (command === "scan_cleanup" || command === "scan_deep_cleanup") {
      return Promise.resolve({
        items: [{
          id: "cache-1",
          category: "Cache Edge",
          path: "Cache",
          sizeBytes: 1024,
          fileCount: 2,
          skippedCount: 0,
          safeToDelete: true,
          safetyLabel: "Aman dihapus",
          safetyNote: "Cache sementara",
        }],
        totalBytes: 1024,
        totalFiles: 2,
        skippedCount: 0,
      });
    }
    if (command === "scan_project_artifacts") {
      return Promise.resolve({
        items: [{
          id: "purge-node-modules",
          category: "JS dependencies",
          path: "C:\\Projects\\demo\\node_modules",
          sizeBytes: 4096,
          fileCount: 12,
          skippedCount: 0,
          safeToDelete: false,
          safetyLabel: "Periksa dahulu",
          safetyNote: "Artefak proyek dapat dibuat ulang",
        }],
        totalBytes: 4096,
        totalFiles: 12,
        skippedCount: 0,
      });
    }
    if (command === "scan_installers") {
      return Promise.resolve({
        items: [{
          id: "purge-installer",
          category: "Installer Windows",
          path: "C:\\Users\\demo\\Downloads\\setup.msi",
          sizeBytes: 20_000_000,
          fileCount: 1,
          skippedCount: 0,
          safeToDelete: false,
          safetyLabel: "Periksa dahulu",
          safetyNote: "File installer besar",
        }],
        totalBytes: 20_000_000,
        totalFiles: 1,
        skippedCount: 0,
      });
    }
    if (command === "delete_cleanup_items") {
      return Promise.resolve({ success: true, message: "Item terpilih telah dihapus permanen.", affectedCount: 1, reclaimedBytes: 1024, skippedCount: 0 });
    }
    if (command === "list_installed_apps") {
      return Promise.resolve([{
        id: "app-1",
        name: "Editor Contoh",
        publisher: "Leo Studio",
        version: "2.0",
        estimatedSizeBytes: 8192,
        installLocation: "C:\\Apps\\Editor",
        supported: true,
      }]);
    }
    if (command === "measure_app_installation") {
      return Promise.resolve({
        appId: "app-1",
        path: "C:\\Apps\\Editor",
        sizeBytes: 16384,
        fileCount: 5,
        skippedCount: 0,
      });
    }
    if (command === "list_storage_volumes") {
      return Promise.resolve([{
        id: "volume-c",
        label: "Windows",
        root: "C:\\",
        filesystem: "NTFS",
        kind: "SSD",
        totalBytes: 100000,
        availableBytes: 40000,
        isSystem: true,
        isRemovable: false,
        isReadOnly: false,
      }]);
    }
    if (command === "start_disk_scan") {
      return Promise.resolve({ jobId: "job-current", root: "C:\\" });
    }
    if (command === "get_active_disk_scan") {
      return Promise.resolve(null);
    }
    return Promise.resolve([]);
  });
});

describe("LeoDisk", () => {
  it("menampilkan status unavailable secara jujur saat GPU dan baterai tidak tersedia", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText("PC-TEST")).toBeInTheDocument());
    expect(screen.getByText("Counter GPU tidak tersedia")).toBeInTheDocument();
    expect(screen.getByText("Tidak ada baterai terdeteksi")).toBeInTheDocument();
  });

  it("menampilkan tab Performa dengan fallback untuk metric null tanpa crash", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_system_snapshot") {
        return Promise.resolve({
          computerName: "PC-NULL",
          osLabel: "Windows 11",
          cpuPercent: null,
          memoryUsed: 0,
          memoryTotal: 0,
          diskUsed: 0,
          diskTotal: 0,
          diskReadPerSec: null,
          diskWritePerSec: null,
          networkDownPerSec: null,
          networkUpPerSec: null,
          gpuPercent: null,
          battery: null,
          uptimeSeconds: 0,
          processes: [{ pid: 12, name: "NullProc", cpuPercent: null, memoryBytes: null }],
        });
      }
      if (command === "get_active_disk_scan") {
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Performa" }));
    await waitFor(() => expect(screen.getByText("PC-NULL")).toBeInTheDocument());
    expect(screen.getAllByText("Tidak tersedia").length).toBeGreaterThan(0);
    expect(screen.getByText("Counter GPU tidak tersedia")).toBeInTheDocument();
  });

  it("berpindah ke tab Bersihkan dan memilih hasil pemindaian", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getAllByText("Cache Edge").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Aman dihapus/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1 clean \+ 0 admin dipilih/)).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("scan_deep_cleanup");
    fireEvent.click(screen.getAllByRole("button", { name: "Buka Folder" })[0]);
    expect(invoke).toHaveBeenCalledWith("open_scanned_location", { itemId: "cache-1" });
  });

  it("mempertahankan hasil Deep Cleanup saat pindah tab", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getAllByText("Cache Edge").length).toBeGreaterThan(0));
    expect(screen.getByText("Preflight Evidence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    await waitFor(() => expect(screen.getByText("PC-TEST")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    expect(screen.getAllByText("Cache Edge").length).toBeGreaterThan(0);
    expect(screen.getByText("Preflight Evidence")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("scan_deep_cleanup");
    expect(invoke.mock.calls.filter(([command]) => command === "scan_deep_cleanup")).toHaveLength(1);
  });

  it("menampilkan grafik cleanup dan filter kategori dari hasil deep scan", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_system_snapshot") {
        return Promise.resolve({
          computerName: "PC-TEST",
          osLabel: "Windows 11",
          cpuPercent: 12,
          memoryUsed: 4_000,
          memoryTotal: 8_000,
          diskUsed: 50_000,
          diskTotal: 100_000,
          networkDownPerSec: 0,
          networkUpPerSec: 0,
          uptimeSeconds: 3600,
          processes: [],
        });
      }
      if (command === "scan_deep_cleanup") {
        return Promise.resolve({
          items: [{
            id: "dev-cache",
            name: "NPM Cache",
            category: "Dev Cache",
            group: "Dev Cache",
            path: "C:\\Users\\demo\\AppData\\Local\\npm-cache",
            sizeBytes: 4096,
            fileCount: 5,
            skippedCount: 0,
            safeToDelete: true,
            riskLevel: "low",
            decision: "clean",
            safetyLabel: "Aman dihapus",
            safetyNote: "Cache package manager",
          }],
          advisories: [],
          categoryTotals: [{ category: "Dev Cache", group: "Dev Cache", sizeBytes: 4096, fileCount: 5, itemCount: 1 }],
          totalBytes: 4096,
          totalFiles: 5,
          skippedCount: 0,
        });
      }
      if (command === "get_active_disk_scan") return Promise.resolve(null);
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getByText("GRAFIK KATEGORI")).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue("Semua Kategori"), { target: { value: "Dev Cache" } });
    expect(screen.getByText(/Filter kategori: Dev Cache/)).toBeInTheDocument();
  });

  it("tidak memilih otomatis item admin advisory dari deep cleanup", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_system_snapshot") {
        return Promise.resolve({
          computerName: "PC-TEST",
          osLabel: "Windows 11",
          cpuPercent: 12,
          memoryUsed: 4_000,
          memoryTotal: 8_000,
          diskUsed: 50_000,
          diskTotal: 100_000,
          networkDownPerSec: 0,
          networkUpPerSec: 0,
          uptimeSeconds: 3600,
          processes: [],
        });
      }
      if (command === "scan_deep_cleanup") {
        return Promise.resolve({
          items: [{
            id: "safe-cache",
            name: "User Temp",
            category: "System Cache",
            group: "System Cache",
            path: "C:\\Users\\demo\\AppData\\Local\\Temp",
            sizeBytes: 1024,
            fileCount: 2,
            skippedCount: 0,
            safeToDelete: true,
            riskLevel: "low",
            decision: "clean",
            safetyLabel: "Aman dihapus",
            safetyNote: "Cache sementara",
          }],
          advisories: [{
            id: "admin-audit",
            name: "Windows Update Download Cache",
            category: "Admin Audit",
            group: "Protected System",
            path: "C:\\Windows\\SoftwareDistribution\\Download",
            sizeBytes: 2048,
            fileCount: 1,
            skippedCount: 0,
            safeToDelete: false,
            riskLevel: "high",
            decision: "advisory",
            safetyLabel: "Audit admin",
            safetyNote: "Protected Windows path",
            scope: "Admin/system audit",
          }],
          categoryTotals: [],
          totalBytes: 1024,
          totalFiles: 2,
          skippedCount: 0,
        });
      }
      if (command === "get_active_disk_scan") return Promise.resolve(null);
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getAllByText("Windows Update Download Cache").length).toBeGreaterThan(0));
    expect(screen.getByText(/1 clean \+ 0 admin dipilih/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: "Pilih Windows Update Download Cache" })[0]).toBeDisabled();
  });

  it("meminta izin dan phrase sebelum menghapus Admin Clean", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_system_snapshot") {
        return Promise.resolve({
          computerName: "PC-TEST",
          osLabel: "Windows 11",
          cpuPercent: 12,
          memoryUsed: 4_000,
          memoryTotal: 8_000,
          diskUsed: 50_000,
          diskTotal: 100_000,
          networkDownPerSec: 0,
          networkUpPerSec: 0,
          uptimeSeconds: 3600,
          processes: [],
        });
      }
      if (command === "scan_deep_cleanup") {
        return Promise.resolve({
          items: [{
            id: "safe-cache",
            name: "User Temp",
            category: "System Cache",
            group: "System Cache",
            path: "C:\\Users\\demo\\AppData\\Local\\Temp",
            sizeBytes: 1024,
            fileCount: 2,
            skippedCount: 0,
            safeToDelete: true,
            riskLevel: "low",
            decision: "clean",
            safetyLabel: "Aman dihapus",
            safetyNote: "Cache sementara",
          }, {
            id: "windows-temp",
            name: "Windows System Temp",
            category: "Admin Clean",
            group: "Protected System",
            path: "C:\\Windows\\Temp",
            sizeBytes: 4096,
            fileCount: 9,
            skippedCount: 1,
            safeToDelete: false,
            riskLevel: "high",
            decision: "admin",
            safetyLabel: "Butuh konfirmasi admin",
            safetyNote: "Folder temp sistem",
            scope: "Admin/system clean",
          }],
          advisories: [],
          categoryTotals: [],
          totalBytes: 5120,
          totalFiles: 11,
          skippedCount: 1,
        });
      }
      if (command === "delete_cleanup_items") {
        return Promise.resolve({ success: true, message: "Item terpilih dipindahkan ke Recycle Bin.", affectedCount: 2, reclaimedBytes: 5120, skippedCount: 1 });
      }
      if (command === "get_active_disk_scan") return Promise.resolve(null);
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getByText("Windows System Temp")).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Pilih Windows System Temp" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Izinkan" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pilih Windows System Temp" }));
    fireEvent.click(screen.getByRole("button", { name: "Hapus item terpilih" }));
    expect(screen.getByText("Admin clean")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ke Recycle Bin/ })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("SAYA MENGERTI"), { target: { value: "SAYA MENGERTI" } });
    fireEvent.click(screen.getByRole("button", { name: /Ke Recycle Bin/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_cleanup_items", expect.objectContaining({
      itemIds: expect.arrayContaining(["safe-cache", "windows-temp"]),
      permanent: false,
      adminConfirmed: true,
      adminConfirmationPhrase: "SAYA MENGERTI",
    })));
  });

  it("menampilkan tab Purge dan tidak memilih hasil secara otomatis", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan artefak" }));
    await waitFor(() => expect(screen.getByText("JS dependencies")).toBeInTheDocument());
    expect(screen.getByText("0 dipilih")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pilih JS dependencies" })).not.toBeChecked();
    expect(invoke).toHaveBeenCalledWith("scan_project_artifacts", { paths: undefined });
  });

  it("navigasi sortable tetap bisa diklik setelah fitur drag aktif", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    await waitFor(() => expect(screen.getByText(/Pilih folder proyek/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    await waitFor(() => expect(screen.getByText("PC-TEST")).toBeInTheDocument());
  });

  it("scan installer dari tab Purge dan menghapus pilihan lewat cleanup backend", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Purge" }));
    fireEvent.click(screen.getByRole("button", { name: "Scan installer" }));
    await waitFor(() => expect(screen.getByText("Installer Windows")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Pilih Installer Windows" }));
    fireEvent.click(screen.getByRole("button", { name: "Hapus item dipilih" }));
    fireEvent.click(screen.getByRole("button", { name: "Ke Recycle Bin" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_cleanup_items", {
      itemIds: ["purge-installer"],
      permanent: false,
    }));
  });

  it("meminta konfirmasi sebelum hapus permanen", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getAllByText("Cache Edge").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Hapus item terpilih" }));
    expect(screen.getByRole("dialog", { name: "Bersihkan item terpilih?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hapus permanen" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("delete_cleanup_items", expect.objectContaining({
      itemIds: ["cache-1"],
      permanent: true,
      adminConfirmed: false,
    })));
  });

  it("menampilkan panel detail dan menghitung ukuran setelah aplikasi diklik", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Aplikasi" }));
    await waitFor(() => expect(screen.getByText("Editor Contoh")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Editor Contoh/ }));
    expect(screen.getByRole("complementary", { name: "Detail aplikasi" })).toHaveTextContent("Leo Studio");
    fireEvent.click(screen.getByRole("button", { name: "Hitung ukuran folder" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("measure_app_installation", { appId: "app-1" }));
    expect(screen.getByText("5 file - 0 dilewati")).toBeInTheDocument();
  });

  it("memberi feedback saat lokasi aplikasi tidak tercantum dan backend mengembalikan error string", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "list_installed_apps") {
        return Promise.resolve([{
          id: "app-empty-location",
          name: "Aplikasi Tanpa Lokasi",
          publisher: "",
          version: "",
          installLocation: "",
          supported: true,
        }]);
      }
      if (command === "open_app_location") {
        return Promise.reject("Lokasi instalasi aplikasi tidak tercantum.");
      }
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Aplikasi" }));
    await waitFor(() => expect(screen.getByText("Aplikasi Tanpa Lokasi")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Aplikasi Tanpa Lokasi/ }));
    expect(screen.getByText(/Registry tidak mencantumkan lokasi instalasi/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Buka lokasi" }));
    await waitFor(() => expect(screen.getByText("Lokasi instalasi aplikasi tidak tercantum.")).toBeInTheDocument());
  });

  it("tidak memilih otomatis item cleanup yang perlu diperiksa", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "get_system_snapshot") {
        return Promise.resolve({
          computerName: "PC-TEST",
          osLabel: "Windows 11",
          cpuPercent: 12,
          memoryUsed: 4_000,
          memoryTotal: 8_000,
          diskUsed: 50_000,
          diskTotal: 100_000,
          networkDownPerSec: 0,
          networkUpPerSec: 0,
          uptimeSeconds: 3600,
          processes: [],
        });
      }
      if (command === "scan_cleanup" || command === "scan_deep_cleanup") {
        return Promise.resolve({
          items: [
            {
              id: "safe-cache",
              category: "Cache aman",
              path: "Cache",
              sizeBytes: 1024,
              fileCount: 2,
              skippedCount: 0,
              safeToDelete: true,
              safetyLabel: "Aman dihapus",
              safetyNote: "Cache sementara",
            },
            {
              id: "review-cache",
              category: "Data perlu diperiksa",
              path: "Data",
              sizeBytes: 2048,
              fileCount: 1,
              skippedCount: 0,
              safeToDelete: false,
              safetyLabel: "Periksa dahulu",
              safetyNote: "Berisi data pengguna",
            },
          ],
          totalBytes: 3072,
          totalFiles: 3,
          skippedCount: 0,
        });
      }
      return Promise.resolve([]);
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Bersihkan" }));
    fireEvent.click(screen.getByRole("button", { name: "Pindai Deep Cleanup" }));
    await waitFor(() => expect(screen.getAllByText("Data perlu diperiksa").length).toBeGreaterThan(0));
    expect(screen.getByText(/1 clean \+ 0 admin dipilih/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Pilih Cache aman" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Pilih Data perlu diperiksa" })).not.toBeChecked();
  });

  it("memilih drive sebelum scan dan mengabaikan event hasil job lama", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Analisis" }));
    await waitFor(() => expect(screen.getByText("Windows")).toBeInTheDocument());
    expect(invoke).not.toHaveBeenCalledWith("start_disk_scan", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Pindai" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_disk_scan", { root: "C:\\" }));
    const complete = listeners.get("disk-scan-complete");
    complete?.({ payload: {
      jobId: "job-old",
      root: "D:\\",
      rootLocationId: "old-root",
      breadcrumbs: [],
      totalBytes: 1,
      fileCount: 1,
      inaccessible: 0,
      folders: [],
      categories: [{ label: "Salah", sizeBytes: 1, fileCount: 1, colorKey: "mint" }],
      largestFiles: [],
    } });
    expect(screen.queryByText("Salah")).not.toBeInTheDocument();
    complete?.({ payload: {
      jobId: "job-current",
      root: "C:\\",
      rootLocationId: "root-c",
      breadcrumbs: [{ locationId: "root-c", label: "C:\\", path: "C:\\" }],
      totalBytes: 60000,
      fileCount: 9,
      inaccessible: 1,
      folders: [],
      categories: [{ label: "Video", sizeBytes: 20000, fileCount: 2, colorKey: "amber" }],
      largestFiles: [],
    } });
    await waitFor(() => expect(screen.getAllByText("Video").length).toBeGreaterThan(0));
  });

  it("mempertahankan hasil scan saat pindah tab selama pemindaian berjalan", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Analisis" }));
    await waitFor(() => expect(screen.getByText("Windows")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Pindai" }));
    await waitFor(() => expect(screen.getByText(/Scan: C:\\/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    listeners.get("disk-scan-progress")?.({ payload: {
      jobId: "job-current",
      root: "C:\\",
      filesScanned: 24,
      foldersScanned: 4,
      bytesScanned: 4096,
      inaccessible: 0,
      currentPath: "C:\\Temp",
    } });
    listeners.get("disk-scan-complete")?.({ payload: {
      jobId: "job-current",
      root: "C:\\",
      rootLocationId: "root-c",
      breadcrumbs: [{ locationId: "root-c", label: "C:\\", path: "C:\\" }],
      totalBytes: 60000,
      fileCount: 9,
      inaccessible: 1,
      folders: [],
      categories: [{ label: "Video", sizeBytes: 20000, fileCount: 2, colorKey: "amber" }],
      largestFiles: [],
    } });
    fireEvent.click(screen.getByRole("button", { name: "Analisis" }));
    await waitFor(() => expect(screen.getAllByText("Video").length).toBeGreaterThan(0));
  });

  it("drop folder dari Explorer memulai scan folder tersebut", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Analisis" }));
    await waitFor(() => expect(screen.getByText("Windows")).toBeInTheDocument());
    await waitFor(() => expect(dragDropHandlers.length).toBeGreaterThan(0));
    dragDropHandlers[0]?.({ payload: { type: "drop", paths: ["C:\\Users\\demo\\Downloads"] } });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_disk_scan", { root: "C:\\Users\\demo\\Downloads" }));
  });
});
