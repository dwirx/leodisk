use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use rayon::prelude::*;
use walkdir::WalkDir;

use crate::{
    models::{ActionReport, ApiError, ApiResult, CleanupItem, CleanupReport},
    state::{AppState, DeleteMode, TrackedDeletion},
    util::{normalized_path, opaque_id, path_display},
};

#[derive(Clone)]
struct ScanRoot {
    category: String,
    path: PathBuf,
    mode: DeleteMode,
    validation_root: PathBuf,
    safe_to_delete: bool,
    safety_label: String,
    safety_note: String,
}

fn safe_root(category: &str, path: PathBuf) -> ScanRoot {
    ScanRoot {
        category: category.into(),
        validation_root: path.clone(),
        path,
        mode: DeleteMode::Children,
        safe_to_delete: true,
        safety_label: "Aman dihapus".into(),
        safety_note:
            "Hanya cache/berkas sementara; aplikasi akan membuatnya kembali bila diperlukan.".into(),
    }
}

fn safe_self_root(category: &str, path: PathBuf) -> Option<ScanRoot> {
    let validation_root = path.parent()?.to_path_buf();
    Some(ScanRoot {
        category: category.into(),
        validation_root,
        path,
        mode: DeleteMode::SelfItem,
        safe_to_delete: true,
        safety_label: "Aman dihapus".into(),
        safety_note:
            "Berkas cache user-level; Windows atau aplikasi akan membuatnya kembali bila diperlukan."
                .into(),
    })
}

fn add_root(roots: &mut Vec<ScanRoot>, category: &str, path: PathBuf) {
    if path.exists() {
        roots.push(safe_root(category, normalized_path(&path)));
    }
}

fn add_file_root(roots: &mut Vec<ScanRoot>, category: &str, path: PathBuf) {
    if path.is_file() {
        if let Some(root) = safe_self_root(category, normalized_path(&path)) {
            roots.push(root);
        }
    }
}

fn add_matching_files(
    roots: &mut Vec<ScanRoot>,
    category: &str,
    directory: PathBuf,
    matches: impl Fn(&str) -> bool,
) {
    for entry in fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if matches(name) {
            add_file_root(roots, category, path);
        }
    }
}

fn browser_profiles(base: PathBuf) -> Vec<PathBuf> {
    fs::read_dir(base)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|name| name == "Default" || name.starts_with("Profile "))
                .map(|matched| matched || path.join("Preferences").exists())
                .unwrap_or(false)
        })
        .collect()
}

fn cleanup_roots() -> Vec<ScanRoot> {
    let mut roots = Vec::new();
    if let Ok(temp) = env::var("TEMP") {
        add_root(&mut roots, "File sementara pengguna", PathBuf::from(temp));
    }
    if let Ok(tmp) = env::var("TMP") {
        add_root(&mut roots, "File sementara pengguna", PathBuf::from(tmp));
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        add_root(&mut roots, "File sementara pengguna", local.join("Temp"));
        add_root(&mut roots, "Cache grafis DirectX", local.join("D3DSCache"));
        add_root(&mut roots, "Laporan crash", local.join("CrashDumps"));
        add_root(
            &mut roots,
            "Laporan error Windows",
            local.join("Microsoft/Windows/WER/ReportArchive"),
        );
        add_root(
            &mut roots,
            "Laporan error Windows",
            local.join("Microsoft/Windows/WER/ReportQueue"),
        );
        add_root(
            &mut roots,
            "Cache internet Windows",
            local.join("Microsoft/Windows/INetCache"),
        );
        add_matching_files(
            &mut roots,
            "Cache thumbnail Windows",
            local.join("Microsoft/Windows/Explorer"),
            |name| name.starts_with("thumbcache_") && name.ends_with(".db"),
        );
        for (name, path) in [
            ("Discord", local.join("Discord")),
            ("Slack", local.join("slack")),
            ("Microsoft Teams", local.join("Microsoft/Teams")),
        ] {
            for cache in ["Cache", "Code Cache", "GPUCache", "DawnCache", "logs"] {
                add_root(&mut roots, &format!("Cache {name}"), path.join(cache));
            }
        }
        for (name, path) in [
            ("Microsoft Edge", local.join("Microsoft/Edge/User Data")),
            ("Google Chrome", local.join("Google/Chrome/User Data")),
            ("Brave", local.join("BraveSoftware/Brave-Browser/User Data")),
            ("Opera", local.join("Opera Software/Opera Stable")),
        ] {
            let profiles = if path.join("Preferences").exists() {
                vec![path]
            } else {
                browser_profiles(path)
            };
            for profile in profiles {
                for cache in [
                    "Cache",
                    "Code Cache",
                    "GPUCache",
                    "DawnCache",
                    "GrShaderCache",
                    "ShaderCache",
                    "Media Cache",
                    "Service Worker/CacheStorage",
                ] {
                    add_root(&mut roots, &format!("Cache {name}"), profile.join(cache));
                }
            }
        }
    }
    if let Ok(appdata) = env::var("APPDATA") {
        let firefox = PathBuf::from(appdata).join("Mozilla/Firefox/Profiles");
        for profile in fs::read_dir(firefox)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            add_root(&mut roots, "Cache Firefox", profile.path().join("cache2"));
            add_root(
                &mut roots,
                "Cache Firefox",
                profile.path().join("startupCache"),
            );
            add_root(
                &mut roots,
                "Cache Firefox",
                profile.path().join("thumbnails"),
            );
        }
    }
    let mut seen = HashSet::new();
    roots.retain(|root| seen.insert(root.path.to_string_lossy().to_ascii_lowercase()));
    roots
}

pub fn measure_path(path: &Path) -> (u64, u64, u64) {
    let mut size = 0;
    let mut files = 0;
    let mut skipped = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        match entry {
            Ok(entry) if entry.file_type().is_symlink() => skipped += 1,
            Ok(entry) if entry.file_type().is_file() => match entry.metadata() {
                Ok(metadata) => {
                    size += metadata.len();
                    files += 1;
                }
                Err(_) => skipped += 1,
            },
            Ok(_) => {}
            Err(_) => skipped += 1,
        }
    }
    (size, files, skipped)
}

fn report_for_roots(roots: Vec<ScanRoot>, state: &AppState) -> ApiResult<CleanupReport> {
    let measured: Vec<(ScanRoot, u64, u64, u64)> = roots
        .into_par_iter()
        .map(|root| {
            let (size, files, skipped) = measure_path(&root.path);
            (root, size, files, skipped)
        })
        .filter(|(_, _, files, skipped)| *files > 0 || *skipped > 0)
        .collect();
    let mut tracked = state
        .deletion_items
        .lock()
        .map_err(|_| ApiError::new("CLEANUP_LOCK", "Hasil pemindaian tidak dapat disimpan."))?;
    let mut locations = state
        .known_locations
        .lock()
        .map_err(|_| ApiError::new("LOCATION_LOCK", "Lokasi hasil pemindaian tidak tersedia."))?;
    let mut items = Vec::new();
    for (root, size_bytes, file_count, skipped_count) in measured {
        let id = opaque_id("clean", &path_display(&root.path));
        tracked.insert(
            id.clone(),
            TrackedDeletion {
                path: root.path.clone(),
                validation_root: root.validation_root,
                mode: root.mode,
                estimated_bytes: size_bytes,
            },
        );
        locations.insert(id.clone(), root.path.clone());
        items.push(CleanupItem {
            id,
            category: root.category,
            path: path_display(&root.path),
            size_bytes,
            file_count,
            skipped_count,
            safe_to_delete: root.safe_to_delete,
            safety_label: root.safety_label,
            safety_note: root.safety_note,
        });
    }
    items.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(build_report(items))
}

pub fn build_report(items: Vec<CleanupItem>) -> CleanupReport {
    CleanupReport {
        total_bytes: items.iter().map(|item| item.size_bytes).sum(),
        total_files: items.iter().map(|item| item.file_count).sum(),
        skipped_count: items.iter().map(|item| item.skipped_count).sum(),
        items,
    }
}

#[tauri::command]
pub fn scan_cleanup(state: tauri::State<'_, AppState>) -> ApiResult<CleanupReport> {
    report_for_roots(cleanup_roots(), &state)
}

pub fn report_remnant_paths(
    category: String,
    paths: Vec<PathBuf>,
    state: &AppState,
) -> ApiResult<CleanupReport> {
    let roots = paths
        .into_iter()
        .filter_map(|path| {
            let parent = path.parent()?.to_path_buf();
            Some(ScanRoot {
                category: category.clone(),
                path,
                validation_root: parent,
                mode: DeleteMode::SelfItem,
                safe_to_delete: false,
                safety_label: "Periksa dahulu".into(),
                safety_note: "Folder dapat berisi pengaturan atau data pengguna aplikasi. Hapus hanya setelah aplikasi sudah tidak dibutuhkan.".into(),
            })
        })
        .collect();
    report_for_roots(roots, state)
}

fn valid_tracked_item(item: &TrackedDeletion) -> bool {
    let path = normalized_path(&item.path);
    let root = normalized_path(&item.validation_root);
    match item.mode {
        DeleteMode::Children => path == root,
        DeleteMode::SelfItem => path.starts_with(&root) && path != root,
    }
}

fn remove_one(path: &Path, permanent: bool) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return false;
    }
    if !permanent {
        return trash::delete(path).is_ok();
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).is_ok()
    } else {
        fs::remove_file(path).is_ok()
    }
}

#[tauri::command]
pub fn delete_cleanup_items(
    item_ids: Vec<String>,
    permanent: bool,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ActionReport> {
    let unique: HashSet<String> = item_ids.into_iter().collect();
    let selected: HashMap<String, TrackedDeletion> = {
        let tracked = state
            .deletion_items
            .lock()
            .map_err(|_| ApiError::new("CLEANUP_LOCK", "Hasil pemindaian tidak tersedia."))?;
        unique
            .iter()
            .filter_map(|id| tracked.get(id).cloned().map(|item| (id.clone(), item)))
            .collect()
    };
    if selected.len() != unique.len() {
        return Err(ApiError::new(
            "INVALID_CLEANUP_ITEMS",
            "Pilihan tidak lagi valid. Silakan pindai ulang.",
        ));
    }
    let mut affected = 0;
    let mut skipped = 0;
    let mut reclaimed = 0;
    for item in selected.values() {
        if !valid_tracked_item(item) {
            skipped += 1;
            continue;
        }
        match item.mode {
            DeleteMode::SelfItem => {
                if remove_one(&item.path, permanent) {
                    affected += 1;
                    reclaimed += item.estimated_bytes;
                } else {
                    skipped += 1;
                }
            }
            DeleteMode::Children => match fs::read_dir(&item.path) {
                Ok(entries) => {
                    let mut removed_any = false;
                    for entry in entries.filter_map(Result::ok) {
                        if remove_one(&entry.path(), permanent) {
                            affected += 1;
                            removed_any = true;
                        } else {
                            skipped += 1;
                        }
                    }
                    if removed_any {
                        reclaimed += item.estimated_bytes;
                    }
                }
                Err(_) => skipped += 1,
            },
        }
    }
    if let Ok(mut tracked) = state.deletion_items.lock() {
        for id in &unique {
            tracked.remove(id);
        }
    }
    if let Ok(mut locations) = state.known_locations.lock() {
        for id in &unique {
            locations.remove(id);
        }
    }
    Ok(ActionReport {
        success: affected > 0,
        message: if affected == 0 {
            "Tidak ada item yang dapat dihapus.".into()
        } else if permanent {
            "Item terpilih telah dihapus permanen.".into()
        } else {
            "Item terpilih dipindahkan ke Recycle Bin.".into()
        },
        affected_count: affected,
        reclaimed_bytes: reclaimed,
        skipped_count: skipped,
    })
}

#[tauri::command]
pub fn open_scanned_location(
    item_id: String,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ActionReport> {
    let path = state
        .known_locations
        .lock()
        .map_err(|_| ApiError::new("LOCATION_LOCK", "Lokasi tidak dapat dibuka."))?
        .get(&item_id)
        .cloned()
        .ok_or_else(|| ApiError::new("LOCATION_NOT_FOUND", "Lokasi tidak lagi tersedia."))?;
    let metadata = fs::metadata(&path).ok();
    let mut command = Command::new("explorer.exe");
    if metadata.map(|metadata| metadata.is_file()).unwrap_or(false) {
        command.arg("/select,").arg(&path);
    } else {
        command.arg(&path);
    }
    command
        .spawn()
        .map_err(|_| ApiError::new("OPEN_LOCATION_FAILED", "Explorer tidak dapat dibuka."))?;
    Ok(ActionReport {
        success: true,
        message: "Lokasi dibuka di File Explorer.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_rejects_item_outside_root() {
        let item = TrackedDeletion {
            path: PathBuf::from(r"C:\Windows\System32"),
            validation_root: PathBuf::from(r"C:\Users\demo\AppData"),
            mode: DeleteMode::SelfItem,
            estimated_bytes: 0,
        };
        assert!(!valid_tracked_item(&item));
    }

    #[test]
    fn report_sums_items_and_preserves_safety() {
        let report = build_report(vec![CleanupItem {
            id: "a".into(),
            category: "Cache".into(),
            path: "test".into(),
            size_bytes: 32,
            file_count: 2,
            skipped_count: 1,
            safe_to_delete: true,
            safety_label: "Aman dihapus".into(),
            safety_note: "Cache".into(),
        }]);
        assert_eq!(report.total_bytes, 32);
        assert_eq!(report.total_files, 2);
        assert!(report.items[0].safe_to_delete);
    }

    #[test]
    fn safe_file_roots_delete_only_the_tracked_file() {
        let root = safe_self_root(
            "Cache thumbnail Windows",
            PathBuf::from(
                r"C:\Users\demo\AppData\Local\Microsoft\Windows\Explorer\thumbcache_256.db",
            ),
        )
        .expect("file path has parent");
        assert!(root.safe_to_delete);
        assert!(matches!(root.mode, DeleteMode::SelfItem));
        assert_eq!(
            root.validation_root,
            PathBuf::from(r"C:\Users\demo\AppData\Local\Microsoft\Windows\Explorer")
        );
    }

    #[test]
    fn temp_roots_delete_children_not_the_temp_folder() {
        let root = safe_root(
            "File sementara pengguna",
            PathBuf::from(r"C:\Users\demo\AppData\Local\Temp"),
        );
        assert!(root.safe_to_delete);
        assert!(matches!(root.mode, DeleteMode::Children));
        assert_eq!(root.validation_root, root.path);
    }
}
