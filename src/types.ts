export type Tab = "clean" | "purge" | "apps" | "optimize" | "analyze" | "performance" | "status";

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
  name?: string;
  kind?: string;
  category: string;
  group?: string;
  path: string;
  sizeBytes: number;
  fileCount: number;
  skippedCount: number;
  safeToDelete: boolean;
  riskLevel?: "low" | "medium" | "high";
  decision?: "clean" | "review" | "manual" | "advisory" | "admin";
  status?: "ready" | "review" | "manual" | "advisory" | "admin" | "notFound" | "blocked";
  priority?: number;
  icon?: string;
  safetyLabel: string;
  safetyNote: string;
  recommendation?: string;
  scope?: string;
  detectedBy?: string;
  detailTags?: string[];
  confidenceLabel?: string;
  advisory?: boolean;
  checked?: boolean;
  exists?: boolean;
  lastScannedAt?: string;
  blockedReason?: string | null;
}

export interface CleanupReportSummary {
  checked: number;
  total: number;
  found: number;
  notFound: number;
  accessLimited: number;
  skipped: number;
  advisoryCount: number;
  totalJunkBytes: number;
  cleanableBytes: number;
  cleanableItems: number;
  reviewBytes: number;
  reviewItems: number;
  manualBytes: number;
  manualItems: number;
  adminBytes: number;
  adminItems: number;
  advisoryBytes: number;
  advisoryItems: number;
}

export interface CleanupCategoryTotal {
  category: string;
  group: string;
  sizeBytes: number;
  fileCount: number;
  itemCount: number;
}

export interface CleanupReport {
  items: CleanupItem[];
  advisories?: CleanupItem[];
  summary?: CleanupReportSummary;
  categoryTotals?: CleanupCategoryTotal[];
  scanEngine?: string;
  cachePath?: string | null;
  totalBytes: number;
  totalFiles: number;
  skippedCount: number;
  scanStartedAt?: string;
  scanFinishedAt?: string;
  durationMs?: number;
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
  engine: string;
}

export interface CleanupScanProgress {
  jobId: string;
  root: string;
  currentPath: string;
  phase?: string;
  elapsedMs?: number;
  rootsScanned: number;
  foldersScanned: number;
  filesScanned: number;
  bytesScanned: number;
  skippedCount: number;
}

export interface CleanupDeleteProgress {
  jobId: string;
  totalItems: number;
  processedItems: number;
  affectedCount: number;
  reclaimedBytes: number;
  skippedCount: number;
  currentPath: string;
}

export interface DiskFolder {
  locationId: string;
  nodeId?: string;
  name: string;
  path: string;
  parentPath?: string;
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
  engine: string;
  cachePath?: string | null;
  rootLocationId: string;
  breadcrumbs: DiskBreadcrumb[];
  parentLocation?: DiskBreadcrumb;
  totalBytes: number;
  fileCount: number;
  inaccessible: number;
  folders: DiskFolder[];
  allFolders?: DiskFolder[];
  categories: DiskCategory[];
  largestFiles: LargeFile[];
}

export interface WizTreeStatus {
  available: boolean;
  verified: boolean;
  executablePath?: string | null;
  installDir: string;
  version: string;
  downloadUrl: string;
  message: string;
  lastError?: string | null;
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
