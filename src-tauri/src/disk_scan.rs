use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use rayon::{prelude::*, ThreadPoolBuilder};
use sysinfo::{DiskKind, Disks};
use tauri::Emitter;

#[cfg(not(windows))]
use std::fs;
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
    name: String,
    path: PathBuf,
    size_bytes: u64,
    file_count: u64,
    inaccessible: u64,
    categories: [CategoryTotal; CATEGORY_COUNT],
    large_files: Vec<(PathBuf, u64)>,
}

impl BranchResult {
    fn new(name: String, path: PathBuf) -> Self {
        Self {
            name,
            path,
            size_bytes: 0,
            file_count: 0,
            inaccessible: 0,
            categories: std::array::from_fn(|_| CategoryTotal::default()),
            large_files: Vec::new(),
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
}

fn scan_branch(
    entry: &RootEntry,
    root: &Path,
    cancelled: &AtomicBool,
    counters: &ScanCounters,
    app: &tauri::AppHandle,
    job_id: &str,
) -> BranchResult {
    let name = if entry.is_dir {
        entry
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Folder".into())
    } else {
        "Berkas di root".into()
    };
    let folder_path = if entry.is_dir {
        entry.path.clone()
    } else {
        root.to_path_buf()
    };
    let mut result = BranchResult::new(name, folder_path);
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

fn scan(
    job_id: String,
    root: PathBuf,
    cancelled: Arc<AtomicBool>,
    app: tauri::AppHandle,
    deletion_items: Arc<Mutex<HashMap<String, TrackedDeletion>>>,
    known_locations: Arc<Mutex<HashMap<String, PathBuf>>>,
    disk_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
) {
    let entries = match read_native_entries(&root) {
        Ok(entries) => entries,
        Err(_) => {
            let _ = app.emit(
                "disk-scan-error",
                DiskScanError {
                    job_id: job_id.clone(),
                    code: "SCAN_READ_FAILED".into(),
                    message: "Folder tidak dapat dibaca.".into(),
                },
            );
            if let Ok(mut jobs) = disk_jobs.lock() {
                jobs.remove(&job_id);
            }
            return;
        }
    };
    let counters = ScanCounters {
        files: AtomicU64::new(0),
        folders: AtomicU64::new(1),
        bytes: AtomicU64::new(0),
        inaccessible: AtomicU64::new(0),
        last_emit: Mutex::new(Instant::now() - Duration::from_secs(1)),
    };
    let scan_entries = || {
        entries
            .par_iter()
            .map(|entry| scan_branch(entry, &root, &cancelled, &counters, &app, &job_id))
            .collect::<Vec<_>>()
    };
    let branches = ThreadPoolBuilder::new()
        .num_threads(scan_worker_count(&root))
        .build()
        .map(|pool| pool.install(scan_entries))
        .unwrap_or_else(|_| {
            entries
                .iter()
                .map(|entry| scan_branch(entry, &root, &cancelled, &counters, &app, &job_id))
                .collect()
        });
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
        return;
    }

    let mut folders: HashMap<String, DiskFolder> = HashMap::new();
    let mut category_totals: [CategoryTotal; CATEGORY_COUNT] =
        std::array::from_fn(|_| CategoryTotal::default());
    let mut large_file_candidates = Vec::new();
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
                let location_id = opaque_id("location", &path_display(&branch.path));
                locations.insert(location_id.clone(), branch.path.clone());
                let folder = folders
                    .entry(path_display(&branch.path))
                    .or_insert_with(|| DiskFolder {
                        location_id,
                        name: branch.name,
                        path: path_display(&branch.path),
                        size_bytes: 0,
                        file_count: 0,
                    });
                folder.size_bytes += branch.size_bytes;
                folder.file_count += branch.file_count;
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
    let mut folders: Vec<DiskFolder> = folders.into_values().collect();
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
            root_location_id,
            breadcrumbs,
            parent_location,
            total_bytes: counters.bytes.load(Ordering::Relaxed),
            file_count: counters.files.load(Ordering::Relaxed),
            inaccessible: counters.inaccessible.load(Ordering::Relaxed),
            folders,
            categories,
            largest_files,
        },
    );
    if let Ok(mut jobs) = disk_jobs.lock() {
        jobs.remove(&job_id);
    }
}

#[tauri::command]
pub fn start_disk_scan(
    root: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ScanJob> {
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
    };
    let deletion_items = state.deletion_items.clone();
    let known_locations = state.known_locations.clone();
    let disk_jobs = state.disk_jobs.clone();
    std::thread::spawn(move || {
        scan(
            job_id,
            root,
            cancelled,
            app,
            deletion_items,
            known_locations,
            disk_jobs,
        );
    });
    Ok(result)
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
}
