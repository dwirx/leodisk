use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use rayon::{prelude::*, ThreadPoolBuilder};
use sysinfo::{DiskKind, Disks};
use tauri::Emitter;
use walkdir::WalkDir;

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::Storage::FileSystem::{
        FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FIND_FIRST_EX_LARGE_FETCH,
        WIN32_FIND_DATAW,
    },
};

use crate::{
    models::{
        ActionReport, ApiError, ApiResult, DiskBreadcrumb, DiskCategory, DiskFolder,
        DiskScanProgress, DiskScanResult, LargeFile, ScanJob,
    },
    state::{AppState, DeleteMode, TrackedDeletion},
    util::{normalized_path, opaque_id, path_display},
};

const LARGE_FILE_BYTES: u64 = 100 * 1024 * 1024;
const LARGE_FILE_LIMIT: usize = 100;
const FOLDER_RESULT_LIMIT: usize = 250;
const CATEGORY_COUNT: usize = 7;
const CATEGORY_INFO: [(&str, &str); CATEGORY_COUNT] = [
    ("Video", "amber"),
    ("Gambar", "blue"),
    ("Audio", "mint"),
    ("Dokumen", "blue"),
    ("Arsip & installer", "amber"),
    ("Data aplikasi/cache", "mint"),
    ("Lainnya", "muted"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiskScanEngine {
    Native,
    Dust,
    WizTree,
}

impl DiskScanEngine {
    fn from_request(value: Option<String>) -> ApiResult<Self> {
        match value
            .as_deref()
            .unwrap_or("native")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "native" => Ok(Self::Native),
            "dust" | "dust-native" | "dustnative" => Ok(Self::Dust),
            "wiztree" | "wiz-tree" => Ok(Self::WizTree),
            _ => Err(ApiError::new(
                "SCAN_ENGINE_UNSUPPORTED",
                "Metode scan tidak dikenali.",
            )),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Native => "Native",
            Self::Dust => "Dust Native",
            Self::WizTree => "WizTree CLI",
        }
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiskScanError {
    job_id: String,
    code: String,
    message: String,
}

struct ScanCounters {
    files: AtomicU64,
    folders: AtomicU64,
    bytes: AtomicU64,
    inaccessible: AtomicU64,
    last_emit: Mutex<Instant>,
}

#[derive(Clone)]
struct RootEntry {
    path: PathBuf,
    is_dir: bool,
    size_bytes: u64,
    reparse: bool,
}

#[derive(Default)]
struct CategoryTotal {
    size_bytes: u64,
    file_count: u64,
}

struct BranchResult {
    path: PathBuf,
    size_bytes: u64,
    file_count: u64,
    inaccessible: u64,
    categories: [CategoryTotal; CATEGORY_COUNT],
    large_files: Vec<(PathBuf, u64)>,
    folders: Vec<(PathBuf, u64, u64)>,
}

impl BranchResult {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            size_bytes: 0,
            file_count: 0,
            inaccessible: 0,
            categories: std::array::from_fn(|_| CategoryTotal::default()),
            large_files: Vec::new(),
            folders: Vec::new(),
        }
    }
}

fn category_index(path: &Path) -> usize {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.contains("\\appdata\\")
        || lower.contains("/appdata/")
        || lower.contains("\\cache")
        || lower.contains("/cache")
        || lower.contains("\\temp\\")
        || lower.contains("/temp/")
    {
        return 5;
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "m4v" => 0,
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" | "raw" | "svg" => 1,
        "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" => 2,
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "csv" => 3,
        "zip" | "rar" | "7z" | "tar" | "gz" | "iso" | "exe" | "msi" | "msix" | "appx" => 4,
        _ => 6,
    }
}

fn add_file(
    result: &mut BranchResult,
    path: &Path,
    size: u64,
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) {
    if cancelled.load(Ordering::Relaxed) {
        return;
    }
    result.size_bytes += size;
    result.file_count += 1;
    let category = &mut result.categories[category_index(path)];
    category.size_bytes += size;
    category.file_count += 1;
    if size >= LARGE_FILE_BYTES {
        result.large_files.push((path.to_path_buf(), size));
    }
    counters.files.fetch_add(1, Ordering::Relaxed);
    counters.bytes.fetch_add(size, Ordering::Relaxed);
    emit_progress(app, job_id, root, path, counters);
}

fn emit_progress(
    app: &tauri::AppHandle,
    job_id: &str,
    root: &Path,
    current: &Path,
    counters: &ScanCounters,
) {
    let files = counters.files.load(Ordering::Relaxed);
    if files % 256 != 0 {
        let Ok(last) = counters.last_emit.lock() else {
            return;
        };
        if last.elapsed() < Duration::from_millis(220) {
            return;
        }
    }
    let Ok(mut last) = counters.last_emit.lock() else {
        return;
    };
    if last.elapsed() < Duration::from_millis(100) {
        return;
    }
    *last = Instant::now();
    let _ = app.emit(
        "disk-scan-progress",
        DiskScanProgress {
            job_id: job_id.to_string(),
            root: path_display(root),
            files_scanned: files,
            folders_scanned: counters.folders.load(Ordering::Relaxed),
            bytes_scanned: counters.bytes.load(Ordering::Relaxed),
            inaccessible: counters.inaccessible.load(Ordering::Relaxed),
            current_path: path_display(current),
        },
    );
}

fn emit_wiztree_status(
    app: &tauri::AppHandle,
    job_id: &str,
    root: &Path,
    counters: &ScanCounters,
    status: String,
) {
    let _ = app.emit(
        "disk-scan-progress",
        DiskScanProgress {
            job_id: job_id.to_string(),
            root: path_display(root),
            files_scanned: counters.files.load(Ordering::Relaxed),
            folders_scanned: counters.folders.load(Ordering::Relaxed),
            bytes_scanned: counters.bytes.load(Ordering::Relaxed),
            inaccessible: counters.inaccessible.load(Ordering::Relaxed),
            current_path: status,
        },
    );
}

#[cfg(windows)]
fn wide_search_path(path: &Path) -> Vec<u16> {
    let display = path_display(path);
    let extended = if display.starts_with(r"\\?\") {
        display
    } else if display.starts_with(r"\\") {
        format!(r"\\?\UNC\{}", display.trim_start_matches('\\'))
    } else {
        format!(r"\\?\{display}")
    };
    PathBuf::from(extended)
        .join("*")
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect()
}

#[cfg(windows)]
fn read_native_entries(path: &Path) -> Result<Vec<RootEntry>, ()> {
    let search = wide_search_path(path);
    let mut data = WIN32_FIND_DATAW::default();
    let handle = unsafe {
        FindFirstFileExW(
            PCWSTR(search.as_ptr()),
            FindExInfoBasic,
            &mut data as *mut _ as *mut _,
            FindExSearchNameMatch,
            None,
            FIND_FIRST_EX_LARGE_FETCH,
        )
    }
    .map_err(|_| ())?;
    let mut entries = Vec::new();
    loop {
        let end = data
            .cFileName
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(data.cFileName.len());
        let name = String::from_utf16_lossy(&data.cFileName[..end]);
        if name != "." && name != ".." {
            let attributes = data.dwFileAttributes;
            entries.push(RootEntry {
                path: path.join(name),
                is_dir: attributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
                size_bytes: ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64,
                reparse: attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0,
            });
        }
        if unsafe { FindNextFileW(handle, &mut data) }.is_err() {
            break;
        }
    }
    let _ = unsafe { FindClose(handle) };
    Ok(entries)
}

#[cfg(not(windows))]
fn read_native_entries(path: &Path) -> Result<Vec<RootEntry>, ()> {
    fs::read_dir(path)
        .map_err(|_| ())?
        .filter_map(Result::ok)
        .map(|entry| {
            let file_type = entry.file_type().map_err(|_| ())?;
            let size_bytes = if file_type.is_file() {
                entry.metadata().map_err(|_| ())?.len()
            } else {
                0
            };
            Ok(RootEntry {
                path: entry.path(),
                is_dir: file_type.is_dir(),
                size_bytes,
                reparse: file_type.is_symlink(),
            })
        })
        .collect()
}

fn walk_directory(
    directory: &Path,
    result: &mut BranchResult,
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) {
    if cancelled.load(Ordering::Relaxed) {
        return;
    }
    let start_size = result.size_bytes;
    let start_files = result.file_count;
    let entries = match read_native_entries(directory) {
        Ok(entries) => entries,
        Err(_) => {
            result.inaccessible += 1;
            counters.inaccessible.fetch_add(1, Ordering::Relaxed);
            return;
        }
    };
    counters.folders.fetch_add(1, Ordering::Relaxed);
    for entry in entries {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        if entry.reparse {
            result.inaccessible += 1;
            counters.inaccessible.fetch_add(1, Ordering::Relaxed);
        } else if entry.is_dir {
            walk_directory(&entry.path, result, root, cancelled, counters, app, job_id);
        } else {
            add_file(
                result,
                &entry.path,
                entry.size_bytes,
                root,
                cancelled,
                counters,
                app,
                job_id,
            );
        }
    }
    let size_bytes = result.size_bytes.saturating_sub(start_size);
    let file_count = result.file_count.saturating_sub(start_files);
    if file_count > 0 {
        result
            .folders
            .push((normalized_path(directory), size_bytes, file_count));
    }
}

fn scan_branch(
    entry: &RootEntry,
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) -> BranchResult {
    let folder_path = if entry.is_dir {
        entry.path.clone()
    } else {
        root.to_path_buf()
    };
    let mut result = BranchResult::new(folder_path);
    if entry.reparse {
        result.inaccessible = 1;
        counters.inaccessible.fetch_add(1, Ordering::Relaxed);
    } else if entry.is_dir {
        walk_directory(
            &entry.path,
            &mut result,
            root,
            cancelled,
            counters,
            app,
            job_id,
        );
    } else {
        add_file(
            &mut result,
            &entry.path,
            entry.size_bytes,
            root,
            cancelled,
            counters,
            app,
            job_id,
        );
    }
    result
}

fn worker_count_for(kind: DiskKind, removable: bool, read_only: bool) -> usize {
    if kind == DiskKind::SSD && !removable && !read_only {
        4
    } else {
        1
    }
}

fn scan_worker_count(root: &Path) -> usize {
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| root.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| worker_count_for(disk.kind(), disk.is_removable(), disk.is_read_only()))
        .unwrap_or(1)
}

fn location_breadcrumb(path: &Path, locations: &mut HashMap<String, PathBuf>) -> DiskBreadcrumb {
    let display = path_display(path);
    let location_id = opaque_id("location", &display);
    locations.insert(location_id.clone(), path.to_path_buf());
    DiskBreadcrumb {
        location_id,
        label: path
            .file_name()
            .map(|label| label.to_string_lossy().into_owned())
            .unwrap_or_else(|| display.clone()),
        path: display,
    }
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_display(path))
}

fn parent_display(path: &Path) -> String {
    path.parent().map(path_display).unwrap_or_default()
}

fn scan_native_branches(
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) -> Result<Vec<BranchResult>, DiskScanError> {
    let entries = read_native_entries(root).map_err(|_| DiskScanError {
        job_id: job_id.to_string(),
        code: "SCAN_READ_FAILED".into(),
        message: "Folder tidak dapat dibaca.".into(),
    })?;
    let scan_entries = || {
        entries
            .par_iter()
            .map(|entry| scan_branch(entry, root, cancelled, counters, app, job_id))
            .collect::<Vec<_>>()
    };
    Ok(ThreadPoolBuilder::new()
        .num_threads(scan_worker_count(root))
        .build()
        .map(|pool| pool.install(scan_entries))
        .unwrap_or_else(|_| {
            entries
                .iter()
                .map(|entry| scan_branch(entry, root, cancelled, counters, app, job_id))
                .collect()
        }))
}

fn add_folder_total(
    folders: &mut HashMap<String, (PathBuf, u64, u64)>,
    folder: &Path,
    root: &Path,
    size_bytes: u64,
) {
    if !folder.starts_with(root) {
        return;
    }
    let normalized = normalized_path(folder);
    let key = path_display(&normalized).to_lowercase();
    let entry = folders.entry(key).or_insert((normalized, 0, 0));
    entry.1 = entry.1.saturating_add(size_bytes);
    entry.2 = entry.2.saturating_add(1);
}

fn scan_dust_branches(
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) -> Result<Vec<BranchResult>, DiskScanError> {
    if !root.is_dir() {
        return Err(DiskScanError {
            job_id: job_id.to_string(),
            code: "SCAN_READ_FAILED".into(),
            message: "Folder tidak dapat dibaca.".into(),
        });
    }
    let mut result = BranchResult::new(root.to_path_buf());
    let mut folder_totals: HashMap<String, (PathBuf, u64, u64)> = HashMap::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter() {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.inaccessible += 1;
                counters.inaccessible.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        let path = entry.path();
        let file_type = entry.file_type();
        if file_type.is_dir() {
            counters.folders.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        if !file_type.is_file() {
            result.inaccessible += 1;
            counters.inaccessible.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let size = match entry.metadata() {
            Ok(metadata) => metadata.len(),
            Err(_) => {
                result.inaccessible += 1;
                counters.inaccessible.fetch_add(1, Ordering::Relaxed);
                continue;
            }
        };
        add_file(
            &mut result,
            path,
            size,
            root,
            cancelled,
            counters,
            app,
            job_id,
        );
        let mut current = path.parent();
        while let Some(folder) = current {
            add_folder_total(&mut folder_totals, folder, root, size);
            if same_filesystem_root(folder, root) {
                break;
            }
            current = folder.parent();
        }
    }
    result.folders = folder_totals.into_values().collect();
    Ok(vec![result])
}

fn same_filesystem_root(left: &Path, right: &Path) -> bool {
    path_display(&normalized_path(left))
        .eq_ignore_ascii_case(&path_display(&normalized_path(right)))
}

fn parse_wiztree_u64(value: Option<&str>) -> u64 {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn trim_wiztree_folder_path(path: &str) -> String {
    let mut value = path.trim().trim_matches('"').to_string();
    while value.len() > 3 && (value.ends_with('\\') || value.ends_with('/')) {
        value.pop();
    }
    value
}

fn is_wiztree_header_line(line: &str) -> bool {
    let trimmed = line
        .trim_start_matches('\u{feff}')
        .trim_start()
        .trim_matches('"');
    trimmed.starts_with("File Name,") || trimmed.starts_with("File Name\",")
}

fn wiztree_csv_data_section(content: &str) -> Option<&str> {
    let mut offset = 0;
    for chunk in content.split_inclusive('\n') {
        let line = chunk.trim_end_matches(['\r', '\n']);
        if is_wiztree_header_line(line) {
            return Some(&content[offset..]);
        }
        offset += chunk.len();
    }
    if offset < content.len() {
        let line = &content[offset..];
        if is_wiztree_header_line(line) {
            return Some(line);
        }
    }
    None
}

fn wiztree_column_index(headers: &csv::StringRecord, name: &str, fallback: usize) -> usize {
    headers
        .iter()
        .position(|header| header.trim().trim_matches('"') == name)
        .unwrap_or(fallback)
}

fn run_wiztree_export(
    root: &Path,
    cache_path: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) -> Result<(), DiskScanError> {
    let exe = crate::wiztree::executable(app).ok_or_else(|| DiskScanError {
        job_id: String::new(),
        code: "WIZTREE_NOT_FOUND".into(),
        message: "WizTree portable belum ditemukan. Download portable resmi dari panel WizTree, lalu scan ulang.".into(),
    })?;
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).map_err(|_| DiskScanError {
            job_id: String::new(),
            code: "WIZTREE_CACHE_FAILED".into(),
            message: "Folder cache WizTree tidak dapat dibuat.".into(),
        })?;
    }
    let _ = fs::remove_file(cache_path);
    let mut command = crate::wiztree::command(&exe);
    command.arg(path_display(root));
    for arg in crate::wiztree::cli_args(app, cache_path) {
        command.arg(arg);
    }
    let mut child = command.spawn().map_err(|_| DiskScanError {
        job_id: String::new(),
        code: "WIZTREE_START_FAILED".into(),
        message: "WizTree CLI tidak dapat dijalankan.".into(),
    })?;
    let started = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(DiskScanError {
                job_id: String::new(),
                code: "SCAN_CANCELLED".into(),
                message: "Pemindaian dibatalkan.".into(),
            });
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => {
                return Err(DiskScanError {
                    job_id: String::new(),
                    code: "WIZTREE_EXPORT_FAILED".into(),
                    message: "WizTree gagal membuat CSV scan.".into(),
                });
            }
            Ok(None) => {
                let elapsed = started.elapsed().as_secs();
                let status = if elapsed < 2 {
                    format!("Menjalankan WizTree CLI untuk {}", path_display(root))
                } else if cache_path.is_file() {
                    format!("WizTree menulis CSV cache - {}s", elapsed)
                } else {
                    format!("Menunggu hasil scan WizTree - {}s", elapsed)
                };
                emit_wiztree_status(app, job_id, root, counters, status);
                thread::sleep(Duration::from_millis(500));
            }
            Err(_) => {
                return Err(DiskScanError {
                    job_id: String::new(),
                    code: "WIZTREE_WAIT_FAILED".into(),
                    message: "Status proses WizTree tidak dapat dibaca.".into(),
                });
            }
        }
    }
    if !cache_path.is_file() {
        return Err(DiskScanError {
            job_id: String::new(),
            code: "WIZTREE_EXPORT_MISSING".into(),
            message: "CSV WizTree tidak ditemukan setelah scan selesai.".into(),
        });
    }
    Ok(())
}

fn scan_wiztree_branches(
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) -> Result<(Vec<BranchResult>, PathBuf), DiskScanError> {
    #[cfg(not(windows))]
    {
        let _ = (root, cancelled, counters, app);
        return Err(DiskScanError {
            job_id: job_id.to_string(),
            code: "WIZTREE_WINDOWS_ONLY".into(),
            message: "WizTree CLI hanya tersedia di Windows.",
        });
    }
    #[cfg(windows)]
    {
        let cache_path = crate::wiztree::cache_path(app, "leodisk-wiztree-scan-cache.csv");
        emit_wiztree_status(
            app,
            job_id,
            root,
            counters,
            "Menyiapkan cache CSV WizTree".into(),
        );
        run_wiztree_export(root, &cache_path, cancelled, counters, app, job_id).map_err(
            |mut error| {
                error.job_id = job_id.to_string();
                error
            },
        )?;
        emit_wiztree_status(
            app,
            job_id,
            root,
            counters,
            "Membaca CSV cache WizTree".into(),
        );
        let content = fs::read_to_string(&cache_path).map_err(|_| DiskScanError {
            job_id: job_id.to_string(),
            code: "WIZTREE_CSV_READ_FAILED".into(),
            message: "CSV WizTree tidak dapat dibaca.".into(),
        })?;
        let data_section = wiztree_csv_data_section(&content).ok_or_else(|| DiskScanError {
            job_id: job_id.to_string(),
            code: "WIZTREE_CSV_HEADER_MISSING".into(),
            message: "Header CSV WizTree tidak ditemukan.".into(),
        })?;
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .flexible(true)
            .from_reader(data_section.as_bytes());
        let headers = reader.headers().map_err(|_| DiskScanError {
            job_id: job_id.to_string(),
            code: "WIZTREE_CSV_HEADER_FAILED".into(),
            message: "Header CSV WizTree tidak dapat dibaca.".into(),
        })?;
        let file_name_index = wiztree_column_index(headers, "File Name", 0);
        let size_index = wiztree_column_index(headers, "Size", 1);
        let files_index = wiztree_column_index(headers, "Files", 5);
        let mut result = BranchResult::new(root.to_path_buf());
        for record in reader.records() {
            if cancelled.load(Ordering::Relaxed) {
                return Err(DiskScanError {
                    job_id: job_id.to_string(),
                    code: "SCAN_CANCELLED".into(),
                    message: "Pemindaian dibatalkan.".into(),
                });
            }
            let record = match record {
                Ok(record) => record,
                Err(_) => {
                    result.inaccessible += 1;
                    counters.inaccessible.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
            };
            let Some(raw_path) = record.get(file_name_index) else {
                continue;
            };
            if raw_path.trim().is_empty() {
                continue;
            }
            let is_folder = raw_path.ends_with('\\') || raw_path.ends_with('/');
            let path = PathBuf::from(trim_wiztree_folder_path(raw_path));
            let size = parse_wiztree_u64(record.get(size_index));
            if is_folder {
                counters.folders.fetch_add(1, Ordering::Relaxed);
                result.folders.push((
                    normalized_path(&path),
                    size,
                    parse_wiztree_u64(record.get(files_index)),
                ));
            } else {
                add_file(
                    &mut result,
                    &path,
                    size,
                    root,
                    cancelled,
                    counters,
                    app,
                    job_id,
                );
            }
        }
        Ok((vec![result], cache_path))
    }
}

fn scan(
    job_id: String,
    root: PathBuf,
    engine: DiskScanEngine,
    cancelled: Arc<AtomicBool>,
    app: tauri::AppHandle,
    deletion_items: Arc<Mutex<HashMap<String, TrackedDeletion>>>,
    known_locations: Arc<Mutex<HashMap<String, PathBuf>>>,
    disk_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    active_disk_scan: Arc<Mutex<Option<ScanJob>>>,
) {
    let counters = ScanCounters {
        files: AtomicU64::new(0),
        folders: AtomicU64::new(1),
        bytes: AtomicU64::new(0),
        inaccessible: AtomicU64::new(0),
        last_emit: Mutex::new(Instant::now() - Duration::from_secs(1)),
    };
    let (branches, cache_path) = match engine {
        DiskScanEngine::Native => {
            match scan_native_branches(&root, &cancelled, &counters, &app, &job_id) {
                Ok(branches) => (branches, None),
                Err(error) => {
                    let _ = app.emit("disk-scan-error", error);
                    if let Ok(mut jobs) = disk_jobs.lock() {
                        jobs.remove(&job_id);
                    }
                    if let Ok(mut active) = active_disk_scan.lock() {
                        *active = None;
                    }
                    return;
                }
            }
        }
        DiskScanEngine::Dust => {
            match scan_dust_branches(&root, &cancelled, &counters, &app, &job_id) {
                Ok(branches) => (branches, None),
                Err(error) => {
                    let _ = app.emit("disk-scan-error", error);
                    if let Ok(mut jobs) = disk_jobs.lock() {
                        jobs.remove(&job_id);
                    }
                    if let Ok(mut active) = active_disk_scan.lock() {
                        *active = None;
                    }
                    return;
                }
            }
        }
        DiskScanEngine::WizTree => {
            match scan_wiztree_branches(&root, &cancelled, &counters, &app, &job_id) {
                Ok((branches, cache_path)) => (branches, Some(cache_path)),
                Err(error) => {
                    let _ = app.emit("disk-scan-error", error);
                    if let Ok(mut jobs) = disk_jobs.lock() {
                        jobs.remove(&job_id);
                    }
                    if let Ok(mut active) = active_disk_scan.lock() {
                        *active = None;
                    }
                    return;
                }
            }
        }
    };
    if cancelled.load(Ordering::Relaxed) {
        let _ = app.emit(
            "disk-scan-error",
            DiskScanError {
                job_id: job_id.clone(),
                code: "SCAN_CANCELLED".into(),
                message: "Pemindaian dibatalkan.".into(),
            },
        );
        if let Ok(mut jobs) = disk_jobs.lock() {
            jobs.remove(&job_id);
        }
        if let Ok(mut active) = active_disk_scan.lock() {
            *active = None;
        }
        return;
    }
    if branches.is_empty() {
        let _ = app.emit(
            "disk-scan-error",
            DiskScanError {
                job_id: job_id.clone(),
                code: "SCAN_EMPTY".into(),
                message: "Tidak ada data scan yang dapat dibaca.".into(),
            },
        );
        if let Ok(mut jobs) = disk_jobs.lock() {
            jobs.remove(&job_id);
        }
        if let Ok(mut active) = active_disk_scan.lock() {
            *active = None;
        }
        return;
    }
    let cache_path = cache_path.map(|path| path_display(&path));
    if cancelled.load(Ordering::Relaxed) {
        let _ = app.emit(
            "disk-scan-error",
            DiskScanError {
                job_id: job_id.clone(),
                code: "SCAN_CANCELLED".into(),
                message: "Pemindaian dibatalkan.".into(),
            },
        );
        if let Ok(mut jobs) = disk_jobs.lock() {
            jobs.remove(&job_id);
        }
        if let Ok(mut active) = active_disk_scan.lock() {
            *active = None;
        }
        return;
    }

    let mut category_totals: [CategoryTotal; CATEGORY_COUNT] =
        std::array::from_fn(|_| CategoryTotal::default());
    let mut large_file_candidates = Vec::new();
    let mut all_folder_candidates = Vec::new();
    let (root_location_id, breadcrumbs, parent_location) = if let Ok(mut locations) =
        known_locations.lock()
    {
        let mut breadcrumb_paths: Vec<PathBuf> = root.ancestors().map(Path::to_path_buf).collect();
        breadcrumb_paths.reverse();
        let breadcrumbs = breadcrumb_paths
            .iter()
            .map(|path| location_breadcrumb(path, &mut locations))
            .collect::<Vec<_>>();
        let root_location_id = breadcrumbs
            .last()
            .map(|crumb| crumb.location_id.clone())
            .unwrap_or_else(|| {
                let crumb = location_breadcrumb(&root, &mut locations);
                crumb.location_id
            });
        let parent_location = root
            .parent()
            .filter(|parent| *parent != root && parent.is_dir())
            .map(|parent| location_breadcrumb(parent, &mut locations));
        for branch in branches {
            for (index, category) in branch.categories.iter().enumerate() {
                category_totals[index].size_bytes += category.size_bytes;
                category_totals[index].file_count += category.file_count;
            }
            if branch.file_count > 0 || branch.inaccessible > 0 {
                all_folder_candidates.push((
                    branch.path.clone(),
                    branch.size_bytes,
                    branch.file_count,
                ));
            }
            for (path, size_bytes, file_count) in branch.folders {
                all_folder_candidates.push((path, size_bytes, file_count));
            }
            for (path, size) in branch.large_files {
                let item_id = opaque_id("disk", &path_display(&path));
                locations.insert(item_id.clone(), path.clone());
                large_file_candidates.push((
                    LargeFile {
                        item_id: item_id.clone(),
                        name: path
                            .file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Berkas".into()),
                        path: path_display(&path),
                        size_bytes: size,
                        safe_to_delete: false,
                        safety_label: "Periksa dahulu".into(),
                        safety_note: "File besar dapat merupakan dokumen, arsip, atau data aplikasi. Pastikan tidak dibutuhkan sebelum menghapus permanen.".into(),
                    },
                    TrackedDeletion {
                        path,
                        validation_root: root.clone(),
                        mode: DeleteMode::SelfItem,
                        estimated_bytes: size,
                        clean_allowed: true,
                        decision: "clean".into(),
                    },
                ));
            }
        }
        (root_location_id, breadcrumbs, parent_location)
    } else {
        (String::new(), Vec::new(), None)
    };
    large_file_candidates.sort_by(|a, b| b.0.size_bytes.cmp(&a.0.size_bytes));
    large_file_candidates.truncate(LARGE_FILE_LIMIT);
    let largest_files = large_file_candidates
        .iter()
        .map(|(file, _)| file.clone())
        .collect::<Vec<_>>();
    let tracked_files = large_file_candidates
        .into_iter()
        .map(|(file, tracked)| (file.item_id, tracked));
    if let Ok(mut tracked) = deletion_items.lock() {
        tracked.extend(tracked_files);
    }
    let mut folder_totals: HashMap<String, (PathBuf, u64, u64)> = HashMap::new();
    for (path, size_bytes, file_count) in all_folder_candidates {
        let key = path_display(&normalized_path(&path)).to_lowercase();
        let entry = folder_totals
            .entry(key)
            .or_insert_with(|| (normalized_path(&path), 0, 0));
        entry.1 = entry.1.max(size_bytes);
        entry.2 = entry.2.max(file_count);
    }
    let mut all_folders = if let Ok(mut locations) = known_locations.lock() {
        folder_totals
            .into_values()
            .map(|(path, size_bytes, file_count)| {
                let location_id = opaque_id("location", &path_display(&path));
                locations.insert(location_id.clone(), path.clone());
                DiskFolder {
                    location_id,
                    name: folder_name(&path),
                    parent_path: parent_display(&path),
                    path: path_display(&path),
                    size_bytes,
                    file_count,
                }
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    all_folders.sort_by(|a, b| {
        b.size_bytes
            .cmp(&a.size_bytes)
            .then_with(|| a.path.cmp(&b.path))
    });
    let root_display = path_display(&root);
    let mut folders = all_folders
        .iter()
        .filter(|folder| folder.parent_path.eq_ignore_ascii_case(&root_display))
        .cloned()
        .collect::<Vec<_>>();
    folders.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    folders.truncate(FOLDER_RESULT_LIMIT);
    let categories = CATEGORY_INFO
        .iter()
        .enumerate()
        .filter(|(index, _)| category_totals[*index].file_count > 0)
        .map(|(index, (label, color_key))| DiskCategory {
            label: (*label).into(),
            size_bytes: category_totals[index].size_bytes,
            file_count: category_totals[index].file_count,
            color_key: (*color_key).into(),
        })
        .collect();
    let _ = app.emit(
        "disk-scan-complete",
        DiskScanResult {
            job_id: job_id.clone(),
            root: path_display(&root),
            engine: engine.label().into(),
            cache_path,
            root_location_id,
            breadcrumbs,
            parent_location,
            total_bytes: counters.bytes.load(Ordering::Relaxed),
            file_count: counters.files.load(Ordering::Relaxed),
            inaccessible: counters.inaccessible.load(Ordering::Relaxed),
            folders,
            all_folders,
            categories,
            largest_files,
        },
    );
    if let Ok(mut jobs) = disk_jobs.lock() {
        jobs.remove(&job_id);
    }
    if let Ok(mut active) = active_disk_scan.lock() {
        *active = None;
    }
}

#[tauri::command]
pub fn start_disk_scan(
    root: String,
    scan_engine: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ScanJob> {
    let engine = DiskScanEngine::from_request(scan_engine)?;
    let requested = if root.trim().is_empty() {
        env::var("USERPROFILE").map(PathBuf::from).map_err(|_| {
            ApiError::new("HOME_NOT_FOUND", "Folder profil pengguna tidak ditemukan.")
        })?
    } else {
        PathBuf::from(root)
    };
    let root = normalized_path(&requested);
    if !root.is_dir() {
        return Err(ApiError::new(
            "INVALID_SCAN_ROOT",
            "Pilih folder atau drive yang dapat dibaca.",
        ));
    }
    if engine == DiskScanEngine::WizTree {
        crate::wiztree::verify(&app)?;
    }
    let job_id = opaque_id("scan", &path_display(&root));
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut jobs = state
        .disk_jobs
        .lock()
        .map_err(|_| ApiError::new("SCAN_LOCK", "Pemindaian tidak dapat dimulai."))?;
    if !jobs.is_empty() {
        return Err(ApiError::new(
            "SCAN_ALREADY_RUNNING",
            "Tunggu pemindaian yang sedang berjalan selesai atau batalkan terlebih dahulu.",
        ));
    }
    jobs.insert(job_id.clone(), cancelled.clone());
    let result = ScanJob {
        job_id: job_id.clone(),
        root: path_display(&root),
        engine: engine.label().into(),
    };
    *state
        .active_disk_scan
        .lock()
        .map_err(|_| ApiError::new("SCAN_LOCK", "Status pemindaian tidak dapat disimpan."))? =
        Some(result.clone());
    let deletion_items = state.deletion_items.clone();
    let known_locations = state.known_locations.clone();
    let disk_jobs = state.disk_jobs.clone();
    let active_disk_scan = state.active_disk_scan.clone();
    std::thread::spawn(move || {
        scan(
            job_id,
            root,
            engine,
            cancelled,
            app,
            deletion_items,
            known_locations,
            disk_jobs,
            active_disk_scan,
        );
    });
    Ok(result)
}

fn active_disk_scan(state: &AppState) -> ApiResult<Option<ScanJob>> {
    state
        .active_disk_scan
        .lock()
        .map(|active| active.clone())
        .map_err(|_| ApiError::new("SCAN_LOCK", "Status pemindaian tidak tersedia."))
}

#[tauri::command]
pub fn get_active_disk_scan(state: tauri::State<'_, AppState>) -> ApiResult<Option<ScanJob>> {
    active_disk_scan(&state)
}

#[tauri::command]
pub fn cancel_disk_scan(
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ActionReport> {
    let jobs = state
        .disk_jobs
        .lock()
        .map_err(|_| ApiError::new("SCAN_LOCK", "Status pemindaian tidak tersedia."))?;
    let flag = jobs
        .get(&job_id)
        .ok_or_else(|| ApiError::new("SCAN_NOT_FOUND", "Pemindaian telah selesai."))?;
    flag.store(true, Ordering::Relaxed);
    Ok(ActionReport {
        success: true,
        message: "Permintaan pembatalan dikirim.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_is_one_hundred_megabytes() {
        assert_eq!(LARGE_FILE_BYTES, 104_857_600);
    }

    #[test]
    fn file_categories_cover_cache_and_archives() {
        assert_eq!(
            category_index(Path::new(r"C:\Users\a\AppData\Local\x.db")),
            5
        );
        assert_eq!(category_index(Path::new(r"C:\Downloads\setup.msi")), 4);
        assert_eq!(category_index(Path::new(r"C:\Videos\movie.mkv")), 0);
    }

    #[test]
    fn only_local_ssd_uses_parallel_workers() {
        assert_eq!(worker_count_for(DiskKind::SSD, false, false), 4);
        assert_eq!(worker_count_for(DiskKind::HDD, false, false), 1);
        assert_eq!(worker_count_for(DiskKind::SSD, true, false), 1);
    }

    #[test]
    fn wiztree_csv_section_skips_generated_banner() {
        let csv = "Generated by WizTree 4.31\r\nFile Name,Size,Allocated,Modified,Attributes,Files,Folders\r\n\"C:\\Temp\\\",9,0,2026/06/02 03:46:07,0,1,0\r\n\"C:\\Temp\\sample.txt\",9,0,2026/06/02 03:46:07,0,0,0\r\n";
        let section = wiztree_csv_data_section(csv).expect("wiztree data section");
        let mut reader = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(section.as_bytes());
        let headers = reader.headers().expect("headers");
        assert_eq!(wiztree_column_index(headers, "File Name", 99), 0);
        assert_eq!(wiztree_column_index(headers, "Size", 99), 1);
        let rows = reader.records().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get(0), Some(r"C:\Temp\"));
        assert_eq!(parse_wiztree_u64(rows[1].get(1)), 9);
    }

    #[test]
    fn active_scan_status_returns_current_job() {
        let state = AppState::default();
        assert!(active_disk_scan(&state).unwrap().is_none());
        *state.active_disk_scan.lock().unwrap() = Some(ScanJob {
            job_id: "job-1".into(),
            root: r"C:\".into(),
            engine: "Native".into(),
        });
        let active = active_disk_scan(&state).unwrap().expect("active job");
        assert_eq!(active.job_id, "job-1");
        assert_eq!(active.root, r"C:\");
    }
}
