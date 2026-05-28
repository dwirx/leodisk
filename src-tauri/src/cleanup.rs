use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use rayon::prelude::*;
use walkdir::WalkDir;

use crate::{
    models::{
        ActionReport, ApiError, ApiResult, CleanupCategoryTotal, CleanupItem, CleanupReport,
        CleanupReportSummary,
    },
    state::{AppState, DeleteMode, TrackedDeletion},
    util::{normalized_path, opaque_id, path_display},
};

#[derive(Clone)]
struct ScanRoot {
    name: String,
    kind: String,
    category: String,
    group: String,
    path: PathBuf,
    mode: DeleteMode,
    validation_root: PathBuf,
    safe_to_delete: bool,
    risk_level: String,
    decision: String,
    priority: u32,
    icon: String,
    safety_label: String,
    safety_note: String,
    recommendation: String,
    advisory: bool,
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs().to_string())
        .unwrap_or_else(|_| "0".into())
}

fn scan_root(
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    mode: DeleteMode,
    decision: &str,
    risk_level: &str,
    priority: u32,
    icon: &str,
    safety_label: &str,
    safety_note: &str,
    recommendation: &str,
) -> ScanRoot {
    let validation_root = match mode {
        DeleteMode::Children => path.clone(),
        DeleteMode::SelfItem => path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone()),
    };
    ScanRoot {
        name: name.into(),
        kind: "folder".into(),
        category: category.into(),
        group: group.into(),
        validation_root,
        path,
        mode,
        safe_to_delete: decision == "clean",
        risk_level: risk_level.into(),
        decision: decision.into(),
        priority,
        icon: icon.into(),
        safety_label: safety_label.into(),
        safety_note: safety_note.into(),
        recommendation: recommendation.into(),
        advisory: decision == "advisory",
    }
}

fn safe_root(name: &str, category: &str, group: &str, path: PathBuf, priority: u32, icon: &str) -> ScanRoot {
    scan_root(
        name,
        category,
        group,
        path,
        DeleteMode::Children,
        "clean",
        "low",
        priority,
        icon,
        "Aman dihapus",
        "Folder aman, bisa dibaca penuh, dan siap dibersihkan sekarang.",
        "Cache sementara dapat dibuat ulang oleh Windows atau aplikasi.",
    )
}

fn safe_self_root(category: &str, path: PathBuf) -> Option<ScanRoot> {
    let name = category.to_string();
    Some(ScanRoot {
        name,
        kind: "file".into(),
        category: category.into(),
        group: "System Cache".into(),
        validation_root: path.parent()?.to_path_buf(),
        path,
        mode: DeleteMode::SelfItem,
        safe_to_delete: true,
        risk_level: "low".into(),
        decision: "clean".into(),
        priority: 60,
        icon: "file".into(),
        safety_label: "Aman dihapus".into(),
        safety_note:
            "Berkas cache user-level; Windows atau aplikasi akan membuatnya kembali bila diperlukan."
                .into(),
        recommendation: "Bersihkan bila aplikasi terkait sedang tidak aktif.".into(),
        advisory: false,
    })
}

fn add_root(roots: &mut Vec<ScanRoot>, name: &str, category: &str, group: &str, path: PathBuf, priority: u32, icon: &str) {
    if path.exists() {
        roots.push(safe_root(name, category, group, normalized_path(&path), priority, icon));
    }
}

fn add_file_root(roots: &mut Vec<ScanRoot>, category: &str, path: PathBuf) {
    if path.is_file() {
        if let Some(root) = safe_self_root(category, normalized_path(&path)) {
            roots.push(root);
        }
    }
}

fn add_review_root(
    roots: &mut Vec<ScanRoot>,
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
    note: &str,
) {
    if path.exists() {
        roots.push(scan_root(
            name,
            category,
            group,
            normalized_path(&path),
            DeleteMode::SelfItem,
            "review",
            "medium",
            priority,
            icon,
            "Periksa dahulu",
            note,
            "Buka folder dan pastikan isinya tidak dibutuhkan sebelum dibersihkan manual.",
        ));
    }
}

fn add_manual_root(
    roots: &mut Vec<ScanRoot>,
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
    note: &str,
) {
    if path.exists() {
        roots.push(scan_root(
            name,
            category,
            group,
            normalized_path(&path),
            DeleteMode::SelfItem,
            "manual",
            "high",
            priority,
            icon,
            "Jangan hapus otomatis",
            note,
            "Tinjau dari alat Windows atau dokumentasi aplikasi; LeoDisk hanya membuka lokasi.",
        ));
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
        add_root(&mut roots, "User Temp (%TEMP%)", "System Cache", "System Cache", PathBuf::from(temp), 86, "temp");
    }
    if let Ok(tmp) = env::var("TMP") {
        add_root(&mut roots, "User Temp (%TMP%)", "System Cache", "System Cache", PathBuf::from(tmp), 85, "temp");
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        add_root(&mut roots, "Windows Temp", "System Cache", "System Cache", local.join("Temp"), 100, "windows");
        add_root(&mut roots, "DirectX Shader Cache", "System Cache", "System Cache", local.join("D3DSCache"), 55, "gpu");
        add_root(&mut roots, "Crash Dumps", "System Cache", "System Cache", local.join("CrashDumps"), 52, "crash");
        add_root(
            &mut roots,
            "Windows Error Reports",
            "System Cache",
            "System Cache",
            local.join("Microsoft/Windows/WER/ReportArchive"),
            50,
            "windows",
        );
        add_root(
            &mut roots,
            "Windows Error Queue",
            "System Cache",
            "System Cache",
            local.join("Microsoft/Windows/WER/ReportQueue"),
            51,
            "windows",
        );
        add_root(
            &mut roots,
            "Windows INetCache",
            "Browser Cache",
            "Browser Cache",
            local.join("Microsoft/Windows/INetCache"),
            62,
            "browser",
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
                add_root(&mut roots, &format!("{name} Cache"), "App Cache", "App Cache", path.join(cache), 66, "app");
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
                    add_root(&mut roots, &format!("{name} Cache"), "Browser Cache", "Browser Cache", profile.join(cache), 64, "browser");
                }
            }
        }
        add_root(&mut roots, "VS Code Cache", "Dev Cache", "Dev Cache", local.join("Microsoft/VSCode/Cache"), 67, "code");
        add_root(&mut roots, "VS Code Cached Data", "Dev Cache", "Dev Cache", local.join("Microsoft/VSCode/CachedData"), 67, "code");
        add_root(&mut roots, "NPM Cache", "Dev Cache", "Dev Cache", local.join("npm-cache"), 92, "package");
        add_root(&mut roots, "Yarn Cache", "Dev Cache", "Dev Cache", local.join("Yarn/Cache"), 80, "package");
        add_review_root(&mut roots, "PNPM Store", "Dev Cache", "Dev Cache", local.join("pnpm/store"), 75, "package", "PNPM store bisa dipakai banyak proyek dan perlu review manual.");
        add_review_root(&mut roots, "Bun Cache", "Dev Cache", "Dev Cache", local.join("bun/install/cache"), 76, "package", "Bun cache dapat dibuat ulang, tetapi sebagian isi mungkin sedang dipakai.");
        add_root(&mut roots, "Playwright Browser Cache", "Dev Cache", "Dev Cache", local.join("ms-playwright"), 88, "browser");
        add_root(&mut roots, "NVIDIA Shader Cache", "Game Cache", "Game Cache", local.join("NVIDIA/DXCache"), 68, "gpu");
        add_root(&mut roots, "NVIDIA OpenGL Cache", "Game Cache", "Game Cache", local.join("NVIDIA/GLCache"), 67, "gpu");
        add_root(&mut roots, "AMD Shader Cache", "Game Cache", "Game Cache", local.join("AMD/DxCache"), 67, "gpu");
    }
    if let Ok(appdata) = env::var("APPDATA") {
        let appdata_root = PathBuf::from(&appdata);
        let firefox = PathBuf::from(appdata).join("Mozilla/Firefox/Profiles");
        for profile in fs::read_dir(firefox)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            add_root(&mut roots, "Firefox Cache", "Browser Cache", "Browser Cache", profile.path().join("cache2"), 64, "browser");
            add_root(
                &mut roots,
                "Firefox Startup Cache",
                "Browser Cache",
                "Browser Cache",
                profile.path().join("startupCache"),
                60,
                "browser",
            );
            add_root(
                &mut roots,
                "Firefox Thumbnails",
                "Browser Cache",
                "Browser Cache",
                profile.path().join("thumbnails"),
                60,
                "browser",
            );
        }
        add_root(&mut roots, "Python PIP Cache", "Dev Cache", "Dev Cache", appdata_root.join("pip/Cache"), 96, "python");
        add_root(&mut roots, "Cargo Registry (Rust)", "Dev Cache", "Dev Cache", appdata_root.join("cargo/registry"), 90, "rust");
        add_root(&mut roots, "Cargo Git Cache (Rust)", "Dev Cache", "Dev Cache", appdata_root.join("cargo/git"), 82, "rust");
        add_root(&mut roots, "Dart/Flutter Pub Cache", "Dev Cache", "Dev Cache", appdata_root.join("Pub/Cache"), 60, "package");
    }
    if let Ok(home) = env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        add_review_root(&mut roots, "Folder Downloads", "User Files", "User Files", home.join("Downloads"), 70, "download", "Downloads sering berisi data pribadi dan installer yang masih diperlukan.");
        add_root(&mut roots, "Go Build Cache", "Dev Cache", "Dev Cache", home.join("AppData/Local/go-build"), 58, "go");
        add_root(&mut roots, "Python PIP Cache", "Dev Cache", "Dev Cache", home.join("AppData/Local/pip/Cache"), 96, "python");
        add_root(&mut roots, "Cargo Registry (Rust)", "Dev Cache", "Dev Cache", home.join(".cargo/registry"), 90, "rust");
        add_root(&mut roots, "Cargo Git Cache (Rust)", "Dev Cache", "Dev Cache", home.join(".cargo/git"), 82, "rust");
    }
    add_review_root(&mut roots, "Windows CBS Logs", "Windows Logs", "System Cache", PathBuf::from(r"C:\Windows\Logs\CBS"), 45, "logs", "Log servicing Windows berguna saat troubleshooting update.");
    add_manual_root(&mut roots, "Windows Installer Cache", "System Cache", "System Cache", PathBuf::from(r"C:\Windows\Installer"), 20, "package", "Windows Installer Cache dapat dibutuhkan untuk repair/uninstall aplikasi.");
    let mut seen = HashSet::new();
    roots.retain(|root| seen.insert(root.path.to_string_lossy().to_ascii_lowercase()));
    roots
}

fn advisory_root(
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
    note: &str,
    recommendation: &str,
) -> Option<ScanRoot> {
    if !path.exists() {
        return None;
    }
    Some(scan_root(
        name,
        category,
        group,
        normalized_path(&path),
        DeleteMode::SelfItem,
        "advisory",
        if priority < 30 { "high" } else { "medium" },
        priority,
        icon,
        "Advisory",
        note,
        recommendation,
    ))
}

fn advisory_roots() -> Vec<ScanRoot> {
    let mut roots = Vec::new();
    for drive in ["C:", "D:", "E:", "F:"] {
        let pagefile = PathBuf::from(format!(r"{drive}\pagefile.sys"));
        if let Some(root) = advisory_root(
            &format!("Page File {drive}"),
            "System Advisory",
            "Virtual Disk",
            pagefile,
            25,
            "memory",
            "Virtual memory Windows bisa sangat besar.",
            "Tinjau pengaturan virtual memory, jangan hapus manual.",
        ) {
            roots.push(root);
        }
        let recycle = PathBuf::from(format!(r"{drive}\$RECYCLE.BIN"));
        if let Some(root) = advisory_root(
            &format!("Recycle Bin {drive}"),
            "Recycle Bin",
            "System Trash",
            recycle,
            38,
            "trash",
            "Recycle Bin per drive dapat menyimpan file besar yang sudah tidak dipakai.",
            "Kosongkan Recycle Bin dari Windows bila itemnya sudah aman dibuang.",
        ) {
            roots.push(root);
        }
    }
    if let Some(root) = advisory_root(
        "Hibernate File",
        "System Advisory",
        "Virtual Disk",
        PathBuf::from(r"C:\hiberfil.sys"),
        24,
        "power",
        "File hibernasi Windows dapat memakan ruang beberapa GB.",
        "Jika tidak butuh Hibernate/Fast Startup, nonaktifkan dengan powercfg /h off.",
    ) {
        roots.push(root);
    }
    if let Ok(home) = env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        for child in ["Videos", "Documents", "Pictures"] {
            if let Some(root) = advisory_root(
                &format!("Large {child} Folder"),
                "User Files",
                "Personal Data",
                home.join(child),
                36,
                "folder",
                "Folder data pribadi bisa menjadi penyebab disk penuh.",
                "Review manual; LeoDisk tidak otomatis menghapus data pribadi.",
            ) {
                roots.push(root);
            }
        }
    }
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
    let started = timestamp();
    let timer = Instant::now();
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
        if root.decision == "clean" {
            tracked.insert(
                id.clone(),
                TrackedDeletion {
                    path: root.path.clone(),
                    validation_root: root.validation_root,
                    mode: root.mode,
                    estimated_bytes: size_bytes,
                    clean_allowed: true,
                },
            );
        }
        locations.insert(id.clone(), root.path.clone());
        items.push(CleanupItem {
            id,
            name: root.name,
            kind: root.kind,
            category: root.category,
            group: root.group,
            path: path_display(&root.path),
            size_bytes,
            file_count,
            skipped_count,
            safe_to_delete: root.safe_to_delete,
            risk_level: root.risk_level,
            decision: root.decision.clone(),
            status: if root.decision == "clean" {
                "ready".into()
            } else {
                root.decision.clone()
            },
            priority: root.priority,
            icon: root.icon,
            safety_label: root.safety_label,
            safety_note: root.safety_note,
            recommendation: root.recommendation,
            advisory: root.advisory,
            checked: true,
            exists: true,
            last_scanned_at: started.clone(),
            blocked_reason: if skipped_count > 0 && root.decision != "clean" {
                Some(format!("{skipped_count} item tidak terbaca"))
            } else {
                None
            },
        });
    }
    items.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    let report = build_report(items, started, timestamp(), timer.elapsed().as_millis());
    if let Ok(mut last) = state.last_cleanup_report.lock() {
        *last = Some(report.clone());
    }
    Ok(report)
}

pub fn build_report(
    mut all_items: Vec<CleanupItem>,
    scan_started_at: String,
    scan_finished_at: String,
    duration_ms: u128,
) -> CleanupReport {
    all_items.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| b.size_bytes.cmp(&a.size_bytes))
    });
    let advisories = all_items
        .iter()
        .filter(|item| item.decision == "advisory")
        .cloned()
        .collect::<Vec<_>>();
    let items = all_items
        .into_iter()
        .filter(|item| item.decision != "advisory")
        .collect::<Vec<_>>();
    let mut category_map: BTreeMap<(String, String), (u64, u64, u64)> = BTreeMap::new();
    for item in items.iter().chain(advisories.iter()) {
        let entry = category_map
            .entry((item.category.clone(), item.group.clone()))
            .or_insert((0, 0, 0));
        entry.0 += item.size_bytes;
        entry.1 += item.file_count;
        entry.2 += 1;
    }
    let category_totals = category_map
        .into_iter()
        .map(|((category, group), (size_bytes, file_count, item_count))| CleanupCategoryTotal {
            category,
            group,
            size_bytes,
            file_count,
            item_count,
        })
        .collect::<Vec<_>>();
    let iter_all = items.iter().chain(advisories.iter()).collect::<Vec<_>>();
    let total_bytes = items.iter().map(|item| item.size_bytes).sum();
    let total_files = items.iter().map(|item| item.file_count).sum();
    let skipped_count = iter_all.iter().map(|item| item.skipped_count).sum();
    let summary = CleanupReportSummary {
        checked: iter_all.iter().filter(|item| item.checked).count() as u64,
        total: iter_all.len() as u64,
        found: iter_all.iter().filter(|item| item.exists).count() as u64,
        not_found: iter_all.iter().filter(|item| !item.exists).count() as u64,
        access_limited: iter_all.iter().filter(|item| item.skipped_count > 0).count() as u64,
        skipped: skipped_count,
        advisory_count: advisories.len() as u64,
        total_junk_bytes: total_bytes,
        cleanable_bytes: items
            .iter()
            .filter(|item| item.decision == "clean")
            .map(|item| item.size_bytes)
            .sum(),
        cleanable_items: items.iter().filter(|item| item.decision == "clean").count() as u64,
        review_bytes: items
            .iter()
            .filter(|item| item.decision == "review")
            .map(|item| item.size_bytes)
            .sum(),
        review_items: items.iter().filter(|item| item.decision == "review").count() as u64,
        manual_bytes: items
            .iter()
            .filter(|item| item.decision == "manual")
            .map(|item| item.size_bytes)
            .sum(),
        manual_items: items.iter().filter(|item| item.decision == "manual").count() as u64,
        advisory_bytes: advisories.iter().map(|item| item.size_bytes).sum(),
        advisory_items: advisories.len() as u64,
    };
    CleanupReport {
        total_bytes,
        total_files,
        skipped_count,
        items,
        advisories,
        summary,
        category_totals,
        scan_started_at,
        scan_finished_at,
        duration_ms,
    }
}

#[tauri::command]
pub fn scan_cleanup(state: tauri::State<'_, AppState>) -> ApiResult<CleanupReport> {
    let roots = cleanup_roots()
        .into_iter()
        .filter(|root| root.decision == "clean")
        .collect();
    report_for_roots(roots, &state)
}

#[tauri::command]
pub fn scan_deep_cleanup(state: tauri::State<'_, AppState>) -> ApiResult<CleanupReport> {
    let mut roots = cleanup_roots();
    roots.extend(advisory_roots());
    report_for_roots(roots, &state)
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
                name: category.clone(),
                kind: "folder".into(),
                category: category.clone(),
                group: "App Cache".into(),
                path,
                validation_root: parent,
                mode: DeleteMode::SelfItem,
                safe_to_delete: false,
                risk_level: "medium".into(),
                decision: "review".into(),
                priority: 40,
                icon: "app".into(),
                safety_label: "Periksa dahulu".into(),
                safety_note: "Folder dapat berisi pengaturan atau data pengguna aplikasi. Hapus hanya setelah aplikasi sudah tidak dibutuhkan.".into(),
                recommendation: "Buka folder dan pastikan aplikasi terkait sudah tidak dipakai.".into(),
                advisory: false,
            })
        })
        .collect();
    report_for_roots(roots, state)
}

pub fn report_review_paths(
    paths: Vec<(String, PathBuf, String)>,
    state: &AppState,
) -> ApiResult<CleanupReport> {
    let roots = paths
        .into_iter()
        .filter_map(|(category, path, safety_note)| {
            let parent = path.parent()?.to_path_buf();
            Some(ScanRoot {
                name: category.clone(),
                kind: if path.is_file() { "file".into() } else { "folder".into() },
                category: category.clone(),
                group: "Review".into(),
                path,
                validation_root: parent,
                mode: DeleteMode::SelfItem,
                safe_to_delete: false,
                risk_level: "medium".into(),
                decision: "review".into(),
                priority: 42,
                icon: "review".into(),
                safety_label: "Periksa dahulu".into(),
                safety_note,
                recommendation: "Review manual sebelum menghapus.".into(),
                advisory: false,
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

fn last_report(state: &AppState) -> ApiResult<CleanupReport> {
    state
        .last_cleanup_report
        .lock()
        .map_err(|_| ApiError::new("REPORT_LOCK", "Report cleanup tidak tersedia."))?
        .clone()
        .ok_or_else(|| ApiError::new("REPORT_NOT_FOUND", "Jalankan scan deep cleanup terlebih dahulu."))
}

fn export_dir() -> ApiResult<PathBuf> {
    let dir = env::temp_dir().join("LeoDisk");
    fs::create_dir_all(&dir)
        .map_err(|_| ApiError::new("EXPORT_DIR_FAILED", "Folder export tidak dapat dibuat."))?;
    Ok(dir)
}

fn export_report_path(name: &str, extension: &str) -> ApiResult<PathBuf> {
    Ok(export_dir()?.join(format!("leodisk-{name}-{}.{}", timestamp(), extension)))
}

fn export_action(path: &Path) -> ActionReport {
    ActionReport {
        success: true,
        message: path_display(path),
        affected_count: 1,
        reclaimed_bytes: 0,
        skipped_count: 0,
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[tauri::command]
pub fn export_cleanup_report(state: tauri::State<'_, AppState>) -> ApiResult<ActionReport> {
    let report = last_report(&state)?;
    let path = export_report_path("cleanup-report", "json")?;
    let json = serde_json::to_string_pretty(&report)
        .map_err(|_| ApiError::new("EXPORT_SERIALIZE_FAILED", "Report tidak dapat diekspor."))?;
    fs::write(&path, json)
        .map_err(|_| ApiError::new("EXPORT_WRITE_FAILED", "File export tidak dapat ditulis."))?;
    Ok(export_action(&path))
}

#[tauri::command]
pub fn export_cleanup_metafile(state: tauri::State<'_, AppState>) -> ApiResult<ActionReport> {
    let report = last_report(&state)?;
    let path = export_report_path("cleanup-metafile", "json")?;
    let mut inputs = serde_json::Map::new();
    for item in report.items.iter().chain(report.advisories.iter()) {
        inputs.insert(
            item.path.clone(),
            serde_json::json!({
                "bytes": item.size_bytes,
                "category": item.category,
                "group": item.group,
                "risk": item.risk_level,
                "decision": item.decision,
                "files": item.file_count,
                "skipped": item.skipped_count
            }),
        );
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "inputs": inputs,
        "metadata": {
            "tool": "LeoDisk",
            "scanFinishedAt": report.scan_finished_at,
            "totalBytes": report.summary.total_junk_bytes,
            "cleanableBytes": report.summary.cleanable_bytes
        }
    }))
    .map_err(|_| ApiError::new("EXPORT_SERIALIZE_FAILED", "Metafile tidak dapat diekspor."))?;
    fs::write(&path, json)
        .map_err(|_| ApiError::new("EXPORT_WRITE_FAILED", "File export tidak dapat ditulis."))?;
    Ok(export_action(&path))
}

#[tauri::command]
pub fn export_cleanup_detail(state: tauri::State<'_, AppState>) -> ApiResult<ActionReport> {
    let report = last_report(&state)?;
    let path = export_report_path("cleanup-detail", "html")?;
    let mut file = fs::File::create(&path)
        .map_err(|_| ApiError::new("EXPORT_WRITE_FAILED", "File detail tidak dapat dibuat."))?;
    writeln!(
        file,
        "<!doctype html><meta charset=\"utf-8\"><title>LeoDisk Cleanup Report</title><style>body{{font-family:Segoe UI,sans-serif;background:#111;color:#eee;padding:24px}}table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #333;padding:8px;text-align:left}}.clean{{color:#7ee0b5}}.review{{color:#e8af62}}.manual,.advisory{{color:#df7861}}</style><h1>LeoDisk Cleanup Report</h1><p>Total junk: {} bytes · Cleanable: {} bytes · Advisory: {}</p><table><thead><tr><th>Name</th><th>Decision</th><th>Risk</th><th>Size</th><th>Files</th><th>Path</th><th>Recommendation</th></tr></thead><tbody>",
        report.summary.total_junk_bytes,
        report.summary.cleanable_bytes,
        report.summary.advisory_count
    )
    .map_err(|_| ApiError::new("EXPORT_WRITE_FAILED", "File detail tidak dapat ditulis."))?;
    for item in report.items.iter().chain(report.advisories.iter()) {
        writeln!(
            file,
            "<tr class=\"{}\"><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            escape_html(&item.decision),
            escape_html(&item.name),
            escape_html(&item.decision),
            escape_html(&item.risk_level),
            item.size_bytes,
            item.file_count,
            escape_html(&item.path),
            escape_html(&item.recommendation)
        )
        .map_err(|_| ApiError::new("EXPORT_WRITE_FAILED", "File detail tidak dapat ditulis."))?;
    }
    writeln!(file, "</tbody></table>")
        .map_err(|_| ApiError::new("EXPORT_WRITE_FAILED", "File detail tidak dapat ditulis."))?;
    Ok(export_action(&path))
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
        if !item.clean_allowed {
            skipped += 1;
            continue;
        }
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
            clean_allowed: true,
        };
        assert!(!valid_tracked_item(&item));
    }

    #[test]
    fn report_sums_items_and_preserves_safety() {
        let report = build_report(vec![CleanupItem {
            id: "a".into(),
            name: "Cache".into(),
            kind: "folder".into(),
            category: "Cache".into(),
            group: "System Cache".into(),
            path: "test".into(),
            size_bytes: 32,
            file_count: 2,
            skipped_count: 1,
            safe_to_delete: true,
            risk_level: "low".into(),
            decision: "clean".into(),
            status: "ready".into(),
            priority: 1,
            icon: "cache".into(),
            safety_label: "Aman dihapus".into(),
            safety_note: "Cache".into(),
            recommendation: "Clean".into(),
            advisory: false,
            checked: true,
            exists: true,
            last_scanned_at: "1".into(),
            blocked_reason: None,
        }], "1".into(), "2".into(), 1);
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
            "System Cache",
            "System Cache",
            PathBuf::from(r"C:\Users\demo\AppData\Local\Temp"),
            1,
            "temp",
        );
        assert!(root.safe_to_delete);
        assert!(matches!(root.mode, DeleteMode::Children));
        assert_eq!(root.validation_root, root.path);
    }
}
