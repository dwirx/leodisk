export type Tab = "clean" | "apps" | "optimize" | "analyze" | "performance" | "status";

export interface ApiError {
  code: string;
  message: string;
  skippedCount?: number;
}

export interface ActionReport {
  success: boolean;
  message: string;
  affectedCount: number;
  reclaimedBytes: number;
  skippedCount: number;
}

export interface ProcessMetric {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface BatteryMetric {
  percent: number;
  charging: boolean;
  secondsRemaining?: number;
}

export interface SystemSnapshot {
  computerName: string;
  osLabel: string;
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  diskReadPerSec?: number | null;
  diskWritePerSec?: number | null;
  networkDownPerSec: number;
  networkUpPerSec: number;
  gpuPercent?: number | null;
  battery?: BatteryMetric | null;
  uptimeSeconds: number;
  processes: ProcessMetric[];
}

export interface CleanupItem {
  id: string;
  category: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  skippedCount: number;
  safeToDelete: boolean;
  safetyLabel: string;
  safetyNote: string;
}

export interface CleanupReport {
  items: CleanupItem[];
  totalBytes: number;
  totalFiles: number;
  skippedCount: number;
}

export interface InstalledApp {
  id: string;
  name: string;
  publisher: string;
  version: string;
  estimatedSizeBytes?: number;
  installLocation: string;
  supported: boolean;
}

export interface AppSizeMeasurement {
  appId: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  skippedCount: number;
}

export interface StartupItem {
  name: string;
  command: string;
  source: string;
  enabled: boolean;
}

export interface ScanJob {
  jobId: string;
  root: string;
}

export interface DiskFolder {
  locationId: string;
  name: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
}

export interface DiskBreadcrumb {
  locationId: string;
  label: string;
  path: string;
}

export interface DiskCategory {
  label: string;
  sizeBytes: number;
  fileCount: number;
  colorKey: "mint" | "blue" | "amber" | "muted";
}

export interface LargeFile {
  itemId: string;
  name: string;
  path: string;
  sizeBytes: number;
  safeToDelete: boolean;
  safetyLabel: string;
  safetyNote: string;
}

export interface DiskScanProgress {
  jobId: string;
  root: string;
  filesScanned: number;
  foldersScanned?: number;
  bytesScanned: number;
  inaccessible: number;
  currentPath: string;
}

export interface DiskScanResult {
  jobId: string;
  root: string;
  rootLocationId: string;
  breadcrumbs: DiskBreadcrumb[];
  parentLocation?: DiskBreadcrumb;
  totalBytes: number;
  fileCount: number;
  inaccessible: number;
  folders: DiskFolder[];
  categories: DiskCategory[];
  largestFiles: LargeFile[];
}

export interface StorageVolume {
  id: string;
  label: string;
  root: string;
  filesystem: string;
  kind: string;
  totalBytes: number;
  availableBytes: number;
  isSystem: boolean;
  isRemovable: boolean;
  isReadOnly: boolean;
}
