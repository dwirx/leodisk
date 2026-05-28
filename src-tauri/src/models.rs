use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_count: Option<u64>,
}

impl ApiError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            skipped_count: None,
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    pub success: bool,
    pub message: String,
    pub affected_count: u64,
    pub reclaimed_bytes: u64,
    pub skipped_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetric {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: f32,
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryMetric {
    pub percent: u8,
    pub charging: bool,
    pub seconds_remaining: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSnapshot {
    pub computer_name: String,
    pub os_label: String,
    pub cpu_percent: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub disk_read_per_sec: Option<f64>,
    pub disk_write_per_sec: Option<f64>,
    pub network_down_per_sec: u64,
    pub network_up_per_sec: u64,
    pub gpu_percent: Option<f64>,
    pub battery: Option<BatteryMetric>,
    pub uptime_seconds: u64,
    pub processes: Vec<ProcessMetric>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub category: String,
    pub group: String,
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub skipped_count: u64,
    pub safe_to_delete: bool,
    pub risk_level: String,
    pub decision: String,
    pub status: String,
    pub priority: u32,
    pub icon: String,
    pub safety_label: String,
    pub safety_note: String,
    pub recommendation: String,
    pub scope: String,
    pub detected_by: String,
    pub detail_tags: Vec<String>,
    pub confidence_label: String,
    pub advisory: bool,
    pub checked: bool,
    pub exists: bool,
    pub last_scanned_at: String,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub items: Vec<CleanupItem>,
    pub advisories: Vec<CleanupItem>,
    pub summary: CleanupReportSummary,
    pub category_totals: Vec<CleanupCategoryTotal>,
    pub total_bytes: u64,
    pub total_files: u64,
    pub skipped_count: u64,
    pub scan_started_at: String,
    pub scan_finished_at: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReportSummary {
    pub checked: u64,
    pub total: u64,
    pub found: u64,
    pub not_found: u64,
    pub access_limited: u64,
    pub skipped: u64,
    pub advisory_count: u64,
    pub total_junk_bytes: u64,
    pub cleanable_bytes: u64,
    pub cleanable_items: u64,
    pub review_bytes: u64,
    pub review_items: u64,
    pub manual_bytes: u64,
    pub manual_items: u64,
    pub admin_bytes: u64,
    pub admin_items: u64,
    pub advisory_bytes: u64,
    pub advisory_items: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCategoryTotal {
    pub category: String,
    pub group: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub item_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub estimated_size_bytes: Option<u64>,
    pub install_location: String,
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSizeMeasurement {
    pub app_id: String,
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub skipped_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub name: String,
    pub command: String,
    pub source: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanJob {
    pub job_id: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskFolder {
    pub location_id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskBreadcrumb {
    pub location_id: String,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskCategory {
    pub label: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub color_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub item_id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub safe_to_delete: bool,
    pub safety_label: String,
    pub safety_note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskScanProgress {
    pub job_id: String,
    pub root: String,
    pub files_scanned: u64,
    pub folders_scanned: u64,
    pub bytes_scanned: u64,
    pub inaccessible: u64,
    pub current_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskScanResult {
    pub job_id: String,
    pub root: String,
    pub root_location_id: String,
    pub breadcrumbs: Vec<DiskBreadcrumb>,
    pub parent_location: Option<DiskBreadcrumb>,
    pub total_bytes: u64,
    pub file_count: u64,
    pub inaccessible: u64,
    pub folders: Vec<DiskFolder>,
    pub categories: Vec<DiskCategory>,
    pub largest_files: Vec<LargeFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageVolume {
    pub id: String,
    pub label: String,
    pub root: String,
    pub filesystem: String,
    pub kind: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub is_system: bool,
    pub is_removable: bool,
    pub is_read_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageSettingsDestination {
    Storage,
    Recommendations,
    Volumes,
}
