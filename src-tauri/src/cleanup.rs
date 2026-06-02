use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use rayon::prelude::*;
use tauri::Emitter;
use walkdir::WalkDir;

use crate::{
    models::{
        ActionReport, ApiError, ApiResult, CleanupCategoryTotal, CleanupDeleteProgress,
        CleanupItem, CleanupReport, CleanupReportSummary, CleanupScanProgress, ScanJob,
    },
    state::{AppState, DeleteMode, TrackedDeletion},
    util::{normalized_path, opaque_id, path_display},
};

const ADMIN_CONFIRMATION_PHRASE: &str = "SAYA MENGERTI";
const CLEANUP_FOLDER_EXPANSION_DEPTH: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanupScanEngine {
    Native,
    Dust,
    WizTree,
}

impl CleanupScanEngine {
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
                "CLEANUP_ENGINE_UNSUPPORTED",
                "Metode scan cleanup tidak dikenali.",
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
    scope: String,
    detected_by: String,
    detail_tags: Vec<String>,
    confidence_label: String,
    advisory: bool,
    expand_children: bool,
}

impl ScanRoot {
    fn with_metadata(
        mut self,
        scope: &str,
        detected_by: &str,
        detail_tags: Vec<&str>,
        confidence_label: &str,
    ) -> Self {
        self.scope = scope.into();
        self.detected_by = detected_by.into();
        self.detail_tags = detail_tags.into_iter().map(str::to_string).collect();
        self.confidence_label = confidence_label.into();
        self
    }
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
        DeleteMode::SelfItem => path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.clone()),
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
        scope: "User-level".into(),
        detected_by: "Known cleanup path".into(),
        detail_tags: vec![category.into(), group.into()],
        confidence_label: if decision == "clean" {
            "High confidence".into()
        } else if decision == "admin" {
            "Admin confirmation required".into()
        } else if decision == "advisory" {
            "Audit only".into()
        } else {
            "Manual review".into()
        },
        advisory: decision == "advisory",
        expand_children: false,
    }
}

fn safe_root(
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
) -> ScanRoot {
    let mut root = scan_root(
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
    );
    root.expand_children = true;
    root
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
        scope: "User-level".into(),
        detected_by: "Known cache file pattern".into(),
        detail_tags: vec![category.into(), "file-cache".into()],
        confidence_label: "High confidence".into(),
        advisory: false,
        expand_children: false,
    })
}

fn add_root(
    roots: &mut Vec<ScanRoot>,
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
) {
    if path.exists() {
        roots.push(safe_root(
            name,
            category,
            group,
            normalized_path(&path),
            priority,
            icon,
        ));
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

fn add_admin_audit_root(
    roots: &mut Vec<ScanRoot>,
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
    note: &str,
    recommendation: &str,
) {
    if path.exists() {
        roots.push(admin_audit_root(
            name,
            category,
            group,
            normalized_path(&path),
            priority,
            icon,
            note,
            recommendation,
        ));
    }
}

fn admin_audit_root(
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
    note: &str,
    recommendation: &str,
) -> ScanRoot {
    scan_root(
        name,
        category,
        group,
        path,
        DeleteMode::SelfItem,
        "advisory",
        "high",
        priority,
        icon,
        "Audit admin",
        note,
        recommendation,
    )
    .with_metadata(
        "Admin/system audit",
        "Protected Windows path",
        vec!["admin", "system", "audit-only"],
        "Audit only",
    )
}

fn admin_clean_root(
    name: &str,
    category: &str,
    group: &str,
    path: PathBuf,
    priority: u32,
    icon: &str,
    note: &str,
    recommendation: &str,
) -> ScanRoot {
    let mut root = scan_root(
        name,
        category,
        group,
        path,
        DeleteMode::Children,
        "admin",
        "high",
        priority,
        icon,
        "Butuh konfirmasi admin",
        note,
        recommendation,
    );
    root.expand_children = true;
    root.with_metadata(
        "Admin/system clean",
        "Protected Windows path",
        vec!["admin", "system", "confirmation-required"],
        "Admin confirmation required",
    )
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
        add_root(
            &mut roots,
            "User Temp (%TEMP%)",
            "System Cache",
            "System Cache",
            PathBuf::from(temp),
            86,
            "temp",
        );
    }
    if let Ok(tmp) = env::var("TMP") {
        add_root(
            &mut roots,
            "User Temp (%TMP%)",
            "System Cache",
            "System Cache",
            PathBuf::from(tmp),
            85,
            "temp",
        );
    }
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        add_root(
            &mut roots,
            "Windows Temp",
            "System Cache",
            "System Cache",
            local.join("Temp"),
            100,
            "windows",
        );
        add_root(
            &mut roots,
            "DirectX Shader Cache",
            "System Cache",
            "System Cache",
            local.join("D3DSCache"),
            55,
            "gpu",
        );
        add_root(
            &mut roots,
            "Crash Dumps",
            "System Cache",
            "System Cache",
            local.join("CrashDumps"),
            52,
            "crash",
        );
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
            (
                "Teams Work/School",
                local.join("Packages/MSTeams_8wekyb3d8bbwe/LocalCache/Microsoft/MSTeams"),
            ),
            ("Zoom", local.join("Zoom")),
            ("Figma", local.join("Figma")),
            ("Notion", local.join("Programs/Notion")),
            ("Obsidian", local.join("Obsidian")),
            ("Postman", local.join("Postman")),
            ("Spotify", local.join("Spotify")),
        ] {
            for cache in [
                "Cache",
                "Code Cache",
                "GPUCache",
                "DawnCache",
                "ShaderCache",
                "logs",
                "Crashpad/reports",
            ] {
                add_root(
                    &mut roots,
                    &format!("{name} Cache"),
                    "App Cache",
                    "App Cache",
                    path.join(cache),
                    66,
                    "app",
                );
            }
        }
        for (name, path) in [
            ("Microsoft Edge", local.join("Microsoft/Edge/User Data")),
            ("Google Chrome", local.join("Google/Chrome/User Data")),
            ("Brave", local.join("BraveSoftware/Brave-Browser/User Data")),
            ("Opera", local.join("Opera Software/Opera Stable")),
            ("Vivaldi", local.join("Vivaldi/User Data")),
            (
                "Arc",
                local.join(
                    "Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data",
                ),
            ),
            (
                "Yandex Browser",
                local.join("Yandex/YandexBrowser/User Data"),
            ),
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
                    add_root(
                        &mut roots,
                        &format!("{name} Cache"),
                        "Browser Cache",
                        "Browser Cache",
                        profile.join(cache),
                        64,
                        "browser",
                    );
                }
            }
        }
        add_root(
            &mut roots,
            "VS Code Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("Microsoft/VSCode/Cache"),
            67,
            "code",
        );
        add_root(
            &mut roots,
            "VS Code Cached Data",
            "Dev Cache",
            "Dev Cache",
            local.join("Microsoft/VSCode/CachedData"),
            67,
            "code",
        );
        add_root(
            &mut roots,
            "VS Code GPU Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("Microsoft/VSCode/GPUCache"),
            66,
            "code",
        );
        add_root(
            &mut roots,
            "VS Code Logs",
            "Dev Cache",
            "Dev Cache",
            local.join("Microsoft/VSCode/logs"),
            56,
            "logs",
        );
        add_root(
            &mut roots,
            "JetBrains System Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("JetBrains"),
            61,
            "code",
        );
        add_review_root(&mut roots, "Android Studio Cache", "Dev Cache", "Dev Cache", local.join("Google/AndroidStudio2024.1"), 58, "android", "Cache Android Studio dapat besar, tetapi sebagian berisi indeks dan konfigurasi yang perlu review.");
        add_root(
            &mut roots,
            "Gradle User Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("Gradle/caches"),
            74,
            "package",
        );
        add_review_root(&mut roots, "Docker Desktop Logs", "Dev Cache", "Dev Cache", local.join("Docker/log"), 54, "docker", "Log Docker Desktop aman untuk direview, tetapi pastikan tidak sedang dipakai untuk troubleshooting.");
        add_review_root(
            &mut roots,
            "Docker Desktop Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("Docker/wsl"),
            44,
            "docker",
            "Cache/WSL Docker bisa terkait image atau volume; jangan hapus otomatis.",
        );
        add_root(
            &mut roots,
            "NPM Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("npm-cache"),
            92,
            "package",
        );
        add_root(
            &mut roots,
            "Yarn Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("Yarn/Cache"),
            80,
            "package",
        );
        add_root(
            &mut roots,
            "NuGet Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("NuGet/Cache"),
            72,
            "package",
        );
        add_root(
            &mut roots,
            "Composer Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("Composer/files"),
            68,
            "package",
        );
        add_review_root(
            &mut roots,
            "PNPM Store",
            "Dev Cache",
            "Dev Cache",
            local.join("pnpm/store"),
            75,
            "package",
            "PNPM store bisa dipakai banyak proyek dan perlu review manual.",
        );
        add_review_root(
            &mut roots,
            "Bun Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("bun/install/cache"),
            76,
            "package",
            "Bun cache dapat dibuat ulang, tetapi sebagian isi mungkin sedang dipakai.",
        );
        add_root(
            &mut roots,
            "Playwright Browser Cache",
            "Dev Cache",
            "Dev Cache",
            local.join("ms-playwright"),
            88,
            "browser",
        );
        add_root(
            &mut roots,
            "NVIDIA Shader Cache",
            "Game Cache",
            "Game Cache",
            local.join("NVIDIA/DXCache"),
            68,
            "gpu",
        );
        add_root(
            &mut roots,
            "NVIDIA OpenGL Cache",
            "Game Cache",
            "Game Cache",
            local.join("NVIDIA/GLCache"),
            67,
            "gpu",
        );
        add_root(
            &mut roots,
            "AMD Shader Cache",
            "Game Cache",
            "Game Cache",
            local.join("AMD/DxCache"),
            67,
            "gpu",
        );
        add_root(
            &mut roots,
            "Epic Games Launcher Cache",
            "Game Cache",
            "Game Cache",
            local.join("EpicGamesLauncher/Saved/webcache"),
            63,
            "game",
        );
        add_root(
            &mut roots,
            "Steam HTML Cache",
            "Game Cache",
            "Game Cache",
            local.join("Steam/htmlcache"),
            59,
            "game",
        );
        add_root(
            &mut roots,
            "Battle.net Cache",
            "Game Cache",
            "Game Cache",
            local.join("Battle.net/Cache"),
            59,
            "game",
        );
        add_root(
            &mut roots,
            "Roblox Cache",
            "Game Cache",
            "Game Cache",
            local.join("Roblox/logs"),
            55,
            "game",
        );
    }
    if let Ok(appdata) = env::var("APPDATA") {
        let appdata_root = PathBuf::from(&appdata);
        let firefox = PathBuf::from(appdata).join("Mozilla/Firefox/Profiles");
        for profile in fs::read_dir(firefox)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            add_root(
                &mut roots,
                "Firefox Cache",
                "Browser Cache",
                "Browser Cache",
                profile.path().join("cache2"),
                64,
                "browser",
            );
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
        add_root(
            &mut roots,
            "Python PIP Cache",
            "Dev Cache",
            "Dev Cache",
            appdata_root.join("pip/Cache"),
            96,
            "python",
        );
        add_root(
            &mut roots,
            "Cargo Registry (Rust)",
            "Dev Cache",
            "Dev Cache",
            appdata_root.join("cargo/registry"),
            90,
            "rust",
        );
        add_root(
            &mut roots,
            "Cargo Git Cache (Rust)",
            "Dev Cache",
            "Dev Cache",
            appdata_root.join("cargo/git"),
            82,
            "rust",
        );
        add_root(
            &mut roots,
            "Dart/Flutter Pub Cache",
            "Dev Cache",
            "Dev Cache",
            appdata_root.join("Pub/Cache"),
            60,
            "package",
        );
        add_root(
            &mut roots,
            "Ruby Gems Cache",
            "Dev Cache",
            "Dev Cache",
            appdata_root.join("gem/cache"),
            58,
            "package",
        );
    }
    if let Ok(home) = env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        add_review_root(
            &mut roots,
            "Folder Downloads",
            "User Files",
            "User Files",
            home.join("Downloads"),
            70,
            "download",
            "Downloads sering berisi data pribadi dan installer yang masih diperlukan.",
        );
        add_root(
            &mut roots,
            "Go Build Cache",
            "Dev Cache",
            "Dev Cache",
            home.join("AppData/Local/go-build"),
            58,
            "go",
        );
        add_root(
            &mut roots,
            "Python PIP Cache",
            "Dev Cache",
            "Dev Cache",
            home.join("AppData/Local/pip/Cache"),
            96,
            "python",
        );
        add_root(
            &mut roots,
            "Cargo Registry (Rust)",
            "Dev Cache",
            "Dev Cache",
            home.join(".cargo/registry"),
            90,
            "rust",
        );
        add_root(
            &mut roots,
            "Cargo Git Cache (Rust)",
            "Dev Cache",
            "Dev Cache",
            home.join(".cargo/git"),
            82,
            "rust",
        );
        add_root(
            &mut roots,
            "Gradle Cache",
            "Dev Cache",
            "Dev Cache",
            home.join(".gradle/caches"),
            74,
            "package",
        );
        add_root(
            &mut roots,
            "Maven Repository Cache",
            "Dev Cache",
            "Dev Cache",
            home.join(".m2/repository"),
            57,
            "package",
        );
        add_root(
            &mut roots,
            "Android Build Cache",
            "Dev Cache",
            "Dev Cache",
            home.join(".android/build-cache"),
            57,
            "android",
        );
        add_root(
            &mut roots,
            "Rustup Downloads",
            "Dev Cache",
            "Dev Cache",
            home.join(".rustup/downloads"),
            62,
            "rust",
        );
        add_root(
            &mut roots,
            "Rustup Temp",
            "Dev Cache",
            "Dev Cache",
            home.join(".rustup/tmp"),
            62,
            "rust",
        );
    }
    add_review_root(
        &mut roots,
        "Windows CBS Logs",
        "Windows Logs",
        "System Cache",
        PathBuf::from(r"C:\Windows\Logs\CBS"),
        45,
        "logs",
        "Log servicing Windows berguna saat troubleshooting update.",
    );
    add_manual_root(
        &mut roots,
        "Windows Installer Cache",
        "System Cache",
        "System Cache",
        PathBuf::from(r"C:\Windows\Installer"),
        20,
        "package",
        "Windows Installer Cache dapat dibutuhkan untuk repair/uninstall aplikasi.",
    );
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
    Some(
        scan_root(
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
        )
        .with_metadata(
            "Audit/advisory",
            "Known large-space indicator",
            vec!["advisory", "manual-review"],
            "Audit only",
        ),
    )
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
    if PathBuf::from(r"C:\Windows\Temp").exists() {
        roots.push(admin_clean_root(
            "Windows System Temp",
            "Admin Clean",
            "Protected System",
            normalized_path(Path::new(r"C:\Windows\Temp")),
            31,
            "shield",
            "Folder temp sistem dapat berisi file terkunci atau dipakai service.",
            "Bersihkan hanya setelah review; LeoDisk akan menghapus isi folder saja dan melewati file yang terkunci.",
        ));
    }
    for (name, path, note, recommendation) in [
        (
            "Windows Update Download Cache",
            PathBuf::from(r"C:\Windows\SoftwareDistribution\Download"),
            "Cache Windows Update berada di area sistem dan biasanya butuh izin admin.",
            "Gunakan Storage Sense atau Windows Update troubleshooting bila ingin membersihkan area ini.",
        ),
        (
            "Windows Panther Logs",
            PathBuf::from(r"C:\Windows\Panther"),
            "Log setup/upgrade Windows bisa membantu troubleshooting.",
            "Review manual; jangan hapus saat update/upgrade Windows bermasalah.",
        ),
        (
            "Windows Memory Dumps",
            PathBuf::from(r"C:\Windows\Minidump"),
            "Crash dump sistem bisa besar dan berguna untuk diagnosa BSOD.",
            "Hapus lewat Storage Sense setelah tidak dibutuhkan untuk troubleshooting.",
        ),
        (
            "Windows Prefetch",
            PathBuf::from(r"C:\Windows\Prefetch"),
            "Prefetch adalah optimasi Windows dan bukan target cleanup otomatis.",
            "Biarkan Windows mengelola folder ini kecuali ada instruksi troubleshooting khusus.",
        ),
        (
            "ProgramData Package Cache",
            PathBuf::from(r"C:\ProgramData\Package Cache"),
            "Cache installer global dapat dibutuhkan repair/uninstall aplikasi.",
            "Audit ukuran saja; jangan hapus otomatis.",
        ),
        (
            "ProgramData Crash Dumps",
            PathBuf::from(r"C:\ProgramData\Microsoft\Windows\WER"),
            "Windows Error Reporting global bisa besar tetapi berada di area sistem.",
            "Gunakan Windows cleanup tools bila perlu.",
        ),
    ] {
        add_admin_audit_root(
            &mut roots,
            name,
            "Admin Audit",
            "Protected System",
            path,
            26,
            "shield",
            note,
            recommendation,
        );
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

fn measure_path_with_context(path: &Path, context: Option<&CleanupScanContext>) -> (u64, u64, u64) {
    let mut size = 0;
    let mut files = 0;
    let mut skipped = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        if context
            .map(CleanupScanContext::is_cancelled)
            .unwrap_or(false)
        {
            break;
        }
        match entry {
            Ok(entry) if entry.file_type().is_symlink() => {
                skipped += 1;
                if let Some(context) = context {
                    context.mark_skipped(entry.path());
                }
            }
            Ok(entry) if entry.file_type().is_file() => match entry.metadata() {
                Ok(metadata) => {
                    let length = metadata.len();
                    size += length;
                    files += 1;
                    if let Some(context) = context {
                        context.mark_file(entry.path(), length);
                    }
                }
                Err(_) => {
                    skipped += 1;
                    if let Some(context) = context {
                        context.mark_skipped(entry.path());
                    }
                }
            },
            Ok(entry) => {
                if entry.file_type().is_dir() {
                    if let Some(context) = context {
                        context.mark_folder(entry.path());
                    }
                }
            }
            Err(error) => {
                skipped += 1;
                if let Some(context) = context {
                    context.mark_skipped(error.path().unwrap_or(path));
                }
            }
        }
    }
    (size, files, skipped)
}

fn cleanup_wiztree_csv_section(content: &str) -> Option<&str> {
    let mut offset = 0;
    for chunk in content.split_inclusive('\n') {
        let line = chunk.trim_end_matches(['\r', '\n']);
        let header = line
            .trim_start_matches('\u{feff}')
            .trim_start()
            .trim_matches('"');
        if header.starts_with("File Name,") || header.starts_with("File Name\",") {
            return Some(&content[offset..]);
        }
        offset += chunk.len();
    }
    None
}

fn cleanup_wiztree_u64(value: Option<&str>) -> u64 {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn cleanup_wiztree_column(headers: &csv::StringRecord, name: &str, fallback: usize) -> usize {
    headers
        .iter()
        .position(|header| header.trim().trim_matches('"') == name)
        .unwrap_or(fallback)
}

fn cleanup_wiztree_path_key(path: &str) -> String {
    let mut value = path.trim().trim_matches('"').replace('/', "\\");
    while value.len() > 3 && value.ends_with('\\') {
        value.pop();
    }
    value.to_ascii_lowercase()
}

fn measure_path_with_wiztree(path: &Path, context: &CleanupScanContext) -> (u64, u64, u64) {
    let cache_path = crate::wiztree::cache_path(&context.app, "leodisk-wiztree-cleanup-cache.csv");
    let Some(exe) = crate::wiztree::executable(&context.app) else {
        context.mark_skipped(path);
        return (0, 0, 1);
    };
    if let Some(parent) = cache_path.parent() {
        if fs::create_dir_all(parent).is_err() {
            context.mark_skipped(path);
            return (0, 0, 1);
        }
    }
    let _ = fs::remove_file(&cache_path);
    context.emit(path, "Menyiapkan cache CSV WizTree", true);
    let mut command = crate::wiztree::command(&exe);
    command.arg(path_display(path));
    for arg in crate::wiztree::cli_args(&context.app, &cache_path) {
        command.arg(arg);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            context.mark_skipped(path);
            return (0, 0, 1);
        }
    };
    let started = Instant::now();
    loop {
        if context.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return (0, 0, 1);
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => {
                context.mark_skipped(path);
                return (0, 0, 1);
            }
            Ok(None) => {
                let phase = if started.elapsed() < Duration::from_secs(2) {
                    "Menjalankan WizTree CLI"
                } else if cache_path.is_file() {
                    "WizTree menulis CSV cache"
                } else {
                    "Menunggu hasil scan WizTree"
                };
                context.emit(path, phase, true);
                std::thread::sleep(Duration::from_millis(450));
            }
        }
    }
    context.emit(path, "Membaca CSV cache WizTree", true);
    let Ok(content) = fs::read_to_string(&cache_path) else {
        context.mark_skipped(path);
        return (0, 0, 1);
    };
    let Some(section) = cleanup_wiztree_csv_section(&content) else {
        context.mark_skipped(path);
        return (0, 0, 1);
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(section.as_bytes());
    let Ok(headers) = reader.headers() else {
        context.mark_skipped(path);
        return (0, 0, 1);
    };
    let file_name_index = cleanup_wiztree_column(headers, "File Name", 0);
    let size_index = cleanup_wiztree_column(headers, "Size", 1);
    let files_index = cleanup_wiztree_column(headers, "Files", 5);
    let root_key = cleanup_wiztree_path_key(&path_display(path));
    let mut fallback_size = 0;
    let mut fallback_files = 0;
    for record in reader.records().flatten() {
        let record_path = cleanup_wiztree_path_key(record.get(file_name_index).unwrap_or_default());
        let size = cleanup_wiztree_u64(record.get(size_index));
        let files = cleanup_wiztree_u64(record.get(files_index));
        if record_path == root_key {
            context.bytes_scanned.fetch_add(size, Ordering::Relaxed);
            context.files_scanned.fetch_add(files, Ordering::Relaxed);
            return (size, files, 0);
        }
        fallback_size += size;
        if !record
            .get(file_name_index)
            .unwrap_or_default()
            .ends_with(['\\', '/'])
        {
            fallback_files += 1;
        }
    }
    context
        .bytes_scanned
        .fetch_add(fallback_size, Ordering::Relaxed);
    context
        .files_scanned
        .fetch_add(fallback_files, Ordering::Relaxed);
    (fallback_size, fallback_files, 0)
}

fn measure_path_with_engine(
    path: &Path,
    context: Option<&CleanupScanContext>,
    engine: CleanupScanEngine,
) -> (u64, u64, u64) {
    match (engine, context) {
        (CleanupScanEngine::WizTree, Some(context)) => measure_path_with_wiztree(path, context),
        _ => measure_path_with_context(path, context),
    }
}

struct MeasuredRoot {
    root: ScanRoot,
    size_bytes: u64,
    file_count: u64,
    skipped_count: u64,
}

#[derive(Clone)]
struct CleanupStores {
    deletion_items: Arc<Mutex<HashMap<String, TrackedDeletion>>>,
    known_locations: Arc<Mutex<HashMap<String, PathBuf>>>,
    last_cleanup_report: Arc<Mutex<Option<CleanupReport>>>,
}

#[derive(Clone)]
struct CleanupScanContext {
    app: tauri::AppHandle,
    job_id: String,
    root_label: String,
    cancelled: Arc<AtomicBool>,
    roots_scanned: Arc<AtomicU64>,
    folders_scanned: Arc<AtomicU64>,
    files_scanned: Arc<AtomicU64>,
    bytes_scanned: Arc<AtomicU64>,
    skipped_count: Arc<AtomicU64>,
    started_at: Instant,
    last_emit: Arc<Mutex<Instant>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CleanupJobError {
    job_id: String,
    code: String,
    message: String,
}

impl CleanupScanContext {
    fn new(
        app: tauri::AppHandle,
        job_id: String,
        root_label: String,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            app,
            job_id,
            root_label,
            cancelled,
            roots_scanned: Arc::new(AtomicU64::new(0)),
            folders_scanned: Arc::new(AtomicU64::new(0)),
            files_scanned: Arc::new(AtomicU64::new(0)),
            bytes_scanned: Arc::new(AtomicU64::new(0)),
            skipped_count: Arc::new(AtomicU64::new(0)),
            started_at: Instant::now(),
            last_emit: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn mark_root_done(&self, current: &Path) {
        self.roots_scanned.fetch_add(1, Ordering::Relaxed);
        self.emit(current, "Root selesai diproses", true);
    }

    fn mark_folder(&self, current: &Path) {
        self.folders_scanned.fetch_add(1, Ordering::Relaxed);
        self.emit(current, "Membaca folder", false);
    }

    fn mark_file(&self, current: &Path, size: u64) {
        let files = self.files_scanned.fetch_add(1, Ordering::Relaxed) + 1;
        self.bytes_scanned.fetch_add(size, Ordering::Relaxed);
        if files % 128 == 0 {
            self.emit(current, "Menghitung file", false);
        }
    }

    fn mark_skipped(&self, current: &Path) {
        self.skipped_count.fetch_add(1, Ordering::Relaxed);
        self.emit(current, "Melewati path yang tidak dapat diakses", false);
    }

    fn emit(&self, current: &Path, phase: &str, force: bool) {
        if !force {
            let Ok(last) = self.last_emit.lock() else {
                return;
            };
            if last.elapsed() < Duration::from_millis(220) {
                return;
            }
        }
        let Ok(mut last) = self.last_emit.lock() else {
            return;
        };
        if !force && last.elapsed() < Duration::from_millis(120) {
            return;
        }
        *last = Instant::now();
        let _ = self.app.emit(
            "cleanup-scan-progress",
            CleanupScanProgress {
                job_id: self.job_id.clone(),
                root: self.root_label.clone(),
                current_path: path_display(current),
                phase: phase.into(),
                elapsed_ms: self
                    .started_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
                roots_scanned: self.roots_scanned.load(Ordering::Relaxed),
                folders_scanned: self.folders_scanned.load(Ordering::Relaxed),
                files_scanned: self.files_scanned.load(Ordering::Relaxed),
                bytes_scanned: self.bytes_scanned.load(Ordering::Relaxed),
                skipped_count: self.skipped_count.load(Ordering::Relaxed),
            },
        );
    }
}

#[derive(Clone)]
struct CleanupDeleteContext {
    app: tauri::AppHandle,
    job_id: String,
    total_items: u64,
    processed_items: Arc<AtomicU64>,
    affected_count: Arc<AtomicU64>,
    reclaimed_bytes: Arc<AtomicU64>,
    skipped_count: Arc<AtomicU64>,
    last_emit: Arc<Mutex<Instant>>,
}

impl CleanupDeleteContext {
    fn new(app: tauri::AppHandle, job_id: String, total_items: u64) -> Self {
        Self {
            app,
            job_id,
            total_items,
            processed_items: Arc::new(AtomicU64::new(0)),
            affected_count: Arc::new(AtomicU64::new(0)),
            reclaimed_bytes: Arc::new(AtomicU64::new(0)),
            skipped_count: Arc::new(AtomicU64::new(0)),
            last_emit: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))),
        }
    }

    fn mark(&self, current: &Path, affected_delta: u64, reclaimed_delta: u64, skipped_delta: u64) {
        self.processed_items.fetch_add(1, Ordering::Relaxed);
        if affected_delta > 0 {
            self.affected_count
                .fetch_add(affected_delta, Ordering::Relaxed);
        }
        if reclaimed_delta > 0 {
            self.reclaimed_bytes
                .fetch_add(reclaimed_delta, Ordering::Relaxed);
        }
        if skipped_delta > 0 {
            self.skipped_count
                .fetch_add(skipped_delta, Ordering::Relaxed);
        }
        self.emit(current, true);
    }

    fn emit(&self, current: &Path, force: bool) {
        if !force {
            let Ok(last) = self.last_emit.lock() else {
                return;
            };
            if last.elapsed() < Duration::from_millis(150) {
                return;
            }
        }
        let Ok(mut last) = self.last_emit.lock() else {
            return;
        };
        *last = Instant::now();
        let _ = self.app.emit(
            "cleanup-delete-progress",
            CleanupDeleteProgress {
                job_id: self.job_id.clone(),
                total_items: self.total_items,
                processed_items: self.processed_items.load(Ordering::Relaxed),
                affected_count: self.affected_count.load(Ordering::Relaxed),
                reclaimed_bytes: self.reclaimed_bytes.load(Ordering::Relaxed),
                skipped_count: self.skipped_count.load(Ordering::Relaxed),
                current_path: path_display(current),
            },
        );
    }
}

fn folder_child_root(parent: &ScanRoot, path: PathBuf, depth: usize) -> ScanRoot {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| parent.name.clone());
    let mut detail_tags = parent.detail_tags.clone();
    detail_tags.push(format!("folder-depth-{depth}"));
    ScanRoot {
        name,
        kind: "folder".into(),
        category: parent.category.clone(),
        group: parent.group.clone(),
        path,
        mode: DeleteMode::SelfItem,
        validation_root: parent.path.clone(),
        safe_to_delete: parent.safe_to_delete,
        risk_level: parent.risk_level.clone(),
        decision: parent.decision.clone(),
        priority: parent.priority,
        icon: parent.icon.clone(),
        safety_label: parent.safety_label.clone(),
        safety_note: format!(
            "{} Folder turunan dari {}.",
            parent.safety_note, parent.name
        ),
        recommendation: parent.recommendation.clone(),
        scope: parent.scope.clone(),
        detected_by: format!("{} folder map", parent.detected_by),
        detail_tags,
        confidence_label: parent.confidence_label.clone(),
        advisory: parent.advisory,
        expand_children: false,
    }
}

fn collect_child_folders(
    parent: &ScanRoot,
    current: &Path,
    depth: usize,
    output: &mut Vec<ScanRoot>,
    context: Option<&CleanupScanContext>,
) {
    if depth == 0 {
        return;
    }
    if context
        .map(CleanupScanContext::is_cancelled)
        .unwrap_or(false)
    {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        if let Some(context) = context {
            context.mark_skipped(current);
        }
        return;
    };
    let mut folder_children = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = normalized_path(&entry.path());
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        folder_children.push(path);
    }
    for path in folder_children {
        let before = output.len();
        collect_child_folders(parent, &path, depth - 1, output, context);
        if output.len() == before {
            output.push(folder_child_root(parent, path, depth));
        }
    }
}

fn measure_scan_root_with_context(
    root: ScanRoot,
    context: Option<CleanupScanContext>,
    engine: CleanupScanEngine,
) -> Vec<MeasuredRoot> {
    if context
        .as_ref()
        .map(CleanupScanContext::is_cancelled)
        .unwrap_or(false)
    {
        return Vec::new();
    }
    if root.expand_children && root.path.is_dir() {
        let mut child_folders = Vec::new();
        collect_child_folders(
            &root,
            &root.path,
            CLEANUP_FOLDER_EXPANSION_DEPTH,
            &mut child_folders,
            context.as_ref(),
        );
        let measured_children = child_folders
            .into_iter()
            .filter_map(|child| {
                if context
                    .as_ref()
                    .map(CleanupScanContext::is_cancelled)
                    .unwrap_or(false)
                {
                    return None;
                }
                let (size_bytes, file_count, skipped_count) =
                    measure_path_with_engine(&child.path, context.as_ref(), engine);
                if let Some(context) = context.as_ref() {
                    context.mark_root_done(&child.path);
                }
                (file_count > 0 || skipped_count > 0).then_some(MeasuredRoot {
                    root: child,
                    size_bytes,
                    file_count,
                    skipped_count,
                })
            })
            .collect::<Vec<_>>();
        if !measured_children.is_empty() {
            return measured_children;
        }
    }
    let (size_bytes, file_count, skipped_count) =
        measure_path_with_engine(&root.path, context.as_ref(), engine);
    if let Some(context) = context.as_ref() {
        context.mark_root_done(&root.path);
    }
    (file_count > 0 || skipped_count > 0)
        .then_some(MeasuredRoot {
            root,
            size_bytes,
            file_count,
            skipped_count,
        })
        .into_iter()
        .collect()
}

fn dedupe_roots(roots: Vec<ScanRoot>) -> Vec<ScanRoot> {
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| {
            let key = path_display(&normalized_path(&root.path)).to_lowercase();
            seen.insert(key)
        })
        .collect()
}

fn stores_from_state(state: &AppState) -> CleanupStores {
    CleanupStores {
        deletion_items: state.deletion_items.clone(),
        known_locations: state.known_locations.clone(),
        last_cleanup_report: state.last_cleanup_report.clone(),
    }
}

fn report_for_roots(roots: Vec<ScanRoot>, state: &AppState) -> ApiResult<CleanupReport> {
    report_for_roots_with_stores(
        roots,
        stores_from_state(state),
        None,
        CleanupScanEngine::Native,
    )
}

fn report_for_roots_with_stores(
    roots: Vec<ScanRoot>,
    stores: CleanupStores,
    context: Option<CleanupScanContext>,
    engine: CleanupScanEngine,
) -> ApiResult<CleanupReport> {
    let started = timestamp();
    let timer = Instant::now();
    let deduped_roots = dedupe_roots(roots);
    let measured: Vec<MeasuredRoot> = if engine == CleanupScanEngine::WizTree {
        deduped_roots
            .into_iter()
            .flat_map(|root| measure_scan_root_with_context(root, context.clone(), engine))
            .collect()
    } else {
        deduped_roots
            .into_par_iter()
            .map(|root| measure_scan_root_with_context(root, context.clone(), engine))
            .flatten()
            .collect()
    };
    if context
        .as_ref()
        .map(CleanupScanContext::is_cancelled)
        .unwrap_or(false)
    {
        return Err(ApiError::new(
            "CLEANUP_SCAN_CANCELLED",
            "Pemindaian cleanup dibatalkan.",
        ));
    }
    let mut tracked = stores
        .deletion_items
        .lock()
        .map_err(|_| ApiError::new("CLEANUP_LOCK", "Hasil pemindaian tidak dapat disimpan."))?;
    let mut locations = stores
        .known_locations
        .lock()
        .map_err(|_| ApiError::new("LOCATION_LOCK", "Lokasi hasil pemindaian tidak tersedia."))?;
    let mut items = Vec::new();
    for MeasuredRoot {
        root,
        size_bytes,
        file_count,
        skipped_count,
    } in measured
    {
        let id = opaque_id("clean", &path_display(&root.path));
        if root.decision == "clean" || root.decision == "admin" {
            tracked.insert(
                id.clone(),
                TrackedDeletion {
                    path: root.path.clone(),
                    validation_root: root.validation_root,
                    mode: root.mode,
                    estimated_bytes: size_bytes,
                    clean_allowed: true,
                    decision: root.decision.clone(),
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
            scope: root.scope,
            detected_by: root.detected_by,
            detail_tags: root.detail_tags,
            confidence_label: root.confidence_label,
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
    let cache_path = (engine == CleanupScanEngine::WizTree)
        .then(|| {
            context.as_ref().map(|context| {
                path_display(&crate::wiztree::cache_path(
                    &context.app,
                    "leodisk-wiztree-cleanup-cache.csv",
                ))
            })
        })
        .flatten();
    let report = build_report_with_metadata(
        items,
        started,
        timestamp(),
        timer.elapsed().as_millis(),
        engine.label().into(),
        cache_path,
    );
    if let Ok(mut last) = stores.last_cleanup_report.lock() {
        *last = Some(report.clone());
    }
    Ok(report)
}

#[cfg(test)]
pub fn build_report(
    all_items: Vec<CleanupItem>,
    scan_started_at: String,
    scan_finished_at: String,
    duration_ms: u128,
) -> CleanupReport {
    build_report_with_metadata(
        all_items,
        scan_started_at,
        scan_finished_at,
        duration_ms,
        "Native".into(),
        None,
    )
}

pub fn build_report_with_metadata(
    mut all_items: Vec<CleanupItem>,
    scan_started_at: String,
    scan_finished_at: String,
    duration_ms: u128,
    scan_engine: String,
    cache_path: Option<String>,
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
        .map(
            |((category, group), (size_bytes, file_count, item_count))| CleanupCategoryTotal {
                category,
                group,
                size_bytes,
                file_count,
                item_count,
            },
        )
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
        access_limited: iter_all
            .iter()
            .filter(|item| item.skipped_count > 0)
            .count() as u64,
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
        review_items: items
            .iter()
            .filter(|item| item.decision == "review")
            .count() as u64,
        manual_bytes: items
            .iter()
            .filter(|item| item.decision == "manual")
            .map(|item| item.size_bytes)
            .sum(),
        manual_items: items
            .iter()
            .filter(|item| item.decision == "manual")
            .count() as u64,
        admin_bytes: items
            .iter()
            .filter(|item| item.decision == "admin")
            .map(|item| item.size_bytes)
            .sum(),
        admin_items: items.iter().filter(|item| item.decision == "admin").count() as u64,
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
        scan_engine,
        cache_path,
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

#[tauri::command]
pub fn start_cleanup_scan(
    scan_engine: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ScanJob> {
    let engine = CleanupScanEngine::from_request(scan_engine)?;
    if engine == CleanupScanEngine::WizTree {
        crate::wiztree::verify(&app)?;
    }
    let job_id = opaque_id("cleanup-scan", "deep-cleanup");
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut jobs = state
        .cleanup_jobs
        .lock()
        .map_err(|_| ApiError::new("CLEANUP_SCAN_LOCK", "Scan cleanup tidak dapat dimulai."))?;
    if !jobs.is_empty() {
        return Err(ApiError::new(
            "CLEANUP_SCAN_ALREADY_RUNNING",
            "Scan cleanup masih berjalan. Tunggu selesai atau batalkan terlebih dahulu.",
        ));
    }
    jobs.insert(job_id.clone(), cancelled.clone());
    let job = ScanJob {
        job_id: job_id.clone(),
        root: "Deep Cleanup".into(),
        engine: engine.label().into(),
    };
    *state.active_cleanup_scan.lock().map_err(|_| {
        ApiError::new(
            "CLEANUP_SCAN_LOCK",
            "Status scan cleanup tidak dapat disimpan.",
        )
    })? = Some(job.clone());

    let stores = stores_from_state(&state);
    let cleanup_jobs = state.cleanup_jobs.clone();
    let active_cleanup_scan = state.active_cleanup_scan.clone();
    std::thread::spawn(move || {
        let mut roots = cleanup_roots();
        roots.extend(advisory_roots());
        let context = CleanupScanContext::new(
            app.clone(),
            job_id.clone(),
            format!("Deep Cleanup - {}", engine.label()),
            cancelled,
        );
        let result = report_for_roots_with_stores(roots, stores, Some(context.clone()), engine);
        match result {
            Ok(report) => {
                let _ = app.emit("cleanup-scan-complete", report);
            }
            Err(error) => {
                let _ = app.emit(
                    "cleanup-scan-error",
                    CleanupJobError {
                        job_id: job_id.clone(),
                        code: error.code,
                        message: error.message,
                    },
                );
            }
        }
        if let Ok(mut jobs) = cleanup_jobs.lock() {
            jobs.remove(&job_id);
        }
        if let Ok(mut active) = active_cleanup_scan.lock() {
            *active = None;
        }
    });
    Ok(job)
}

#[tauri::command]
pub fn get_active_cleanup_scan(state: tauri::State<'_, AppState>) -> ApiResult<Option<ScanJob>> {
    state
        .active_cleanup_scan
        .lock()
        .map(|active| active.clone())
        .map_err(|_| ApiError::new("CLEANUP_SCAN_LOCK", "Status scan cleanup tidak tersedia."))
}

#[tauri::command]
pub fn cancel_cleanup_scan(
    job_id: String,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ActionReport> {
    let jobs = state
        .cleanup_jobs
        .lock()
        .map_err(|_| ApiError::new("CLEANUP_SCAN_LOCK", "Status scan cleanup tidak tersedia."))?;
    let flag = jobs
        .get(&job_id)
        .ok_or_else(|| ApiError::new("CLEANUP_SCAN_NOT_FOUND", "Scan cleanup telah selesai."))?;
    flag.store(true, Ordering::Relaxed);
    Ok(ActionReport {
        success: true,
        message: "Permintaan pembatalan scan cleanup dikirim.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
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
                scope: "User-level".into(),
                detected_by: "Installed app remnant match".into(),
                detail_tags: vec!["app-remnant".into(), "review".into()],
                confidence_label: "Manual review".into(),
                advisory: false,
                expand_children: false,
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
                kind: if path.is_file() {
                    "file".into()
                } else {
                    "folder".into()
                },
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
                scope: "User-level".into(),
                detected_by: "User-selected scan".into(),
                detail_tags: vec!["review".into()],
                confidence_label: "Manual review".into(),
                advisory: false,
                expand_children: false,
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

fn admin_delete_confirmed(admin_confirmed: Option<bool>, phrase: Option<&str>) -> bool {
    admin_confirmed.unwrap_or(false)
        && phrase
            .map(str::trim)
            .is_some_and(|phrase| phrase == ADMIN_CONFIRMATION_PHRASE)
}

fn last_report(state: &AppState) -> ApiResult<CleanupReport> {
    state
        .last_cleanup_report
        .lock()
        .map_err(|_| ApiError::new("REPORT_LOCK", "Report cleanup tidak tersedia."))?
        .clone()
        .ok_or_else(|| {
            ApiError::new(
                "REPORT_NOT_FOUND",
                "Jalankan scan deep cleanup terlebih dahulu.",
            )
        })
}

fn selected_cleanup_items(
    item_ids: Vec<String>,
    stores: &CleanupStores,
) -> ApiResult<(HashSet<String>, HashMap<String, TrackedDeletion>)> {
    let unique: HashSet<String> = item_ids.into_iter().collect();
    let selected: HashMap<String, TrackedDeletion> = {
        let tracked = stores
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
    Ok((unique, selected))
}

fn is_nested_under_kept(item: &TrackedDeletion, kept: &[TrackedDeletion]) -> bool {
    let path = normalized_path(&item.path);
    kept.iter().any(|parent| {
        let parent_path = normalized_path(&parent.path);
        path != parent_path && path.starts_with(parent_path)
    })
}

fn dedup_selected_items(selected: HashMap<String, TrackedDeletion>) -> Vec<TrackedDeletion> {
    let mut items = selected.into_values().collect::<Vec<_>>();
    items.sort_by_key(|item| normalized_path(&item.path).components().count());
    let mut kept = Vec::new();
    for item in items {
        if !is_nested_under_kept(&item, &kept) {
            kept.push(item);
        }
    }
    kept
}

fn delete_selected_items(
    unique: HashSet<String>,
    selected: HashMap<String, TrackedDeletion>,
    permanent: bool,
    admin_confirmed: Option<bool>,
    admin_confirmation_phrase: Option<String>,
    stores: CleanupStores,
    context: Option<CleanupDeleteContext>,
) -> ApiResult<ActionReport> {
    let mut affected = 0;
    let mut skipped = 0;
    let mut reclaimed = 0;
    let admin_allowed =
        admin_delete_confirmed(admin_confirmed, admin_confirmation_phrase.as_deref());
    for item in dedup_selected_items(selected) {
        let mut item_affected = 0;
        let mut item_skipped = 0;
        let mut item_reclaimed = 0;
        if !item.clean_allowed
            || (item.decision == "admin" && !admin_allowed)
            || !valid_tracked_item(&item)
        {
            item_skipped += 1;
        } else {
            match item.mode {
                DeleteMode::SelfItem => {
                    if remove_one(&item.path, permanent) {
                        item_affected += 1;
                        item_reclaimed += item.estimated_bytes;
                    } else {
                        item_skipped += 1;
                    }
                }
                DeleteMode::Children => match fs::read_dir(&item.path) {
                    Ok(entries) => {
                        let mut removed_any = false;
                        for entry in entries.filter_map(Result::ok) {
                            if remove_one(&entry.path(), permanent) {
                                item_affected += 1;
                                removed_any = true;
                            } else {
                                item_skipped += 1;
                            }
                        }
                        if removed_any {
                            item_reclaimed += item.estimated_bytes;
                        }
                    }
                    Err(_) => item_skipped += 1,
                },
            }
        }
        affected += item_affected;
        skipped += item_skipped;
        reclaimed += item_reclaimed;
        if let Some(context) = context.as_ref() {
            context.mark(&item.path, item_affected, item_reclaimed, item_skipped);
        }
    }
    if let Ok(mut tracked) = stores.deletion_items.lock() {
        for id in &unique {
            tracked.remove(id);
        }
    }
    if let Ok(mut locations) = stores.known_locations.lock() {
        for id in &unique {
            locations.remove(id);
        }
    }
    Ok(ActionReport {
        success: affected > 0,
        message: if affected == 0 {
            "Tidak ada item yang dapat dihapus.".into()
        } else if permanent {
            format!("{affected} item dihapus permanen. {skipped} item dilewati atau terkunci.")
        } else {
            format!(
                "{affected} item dipindahkan ke Recycle Bin. {skipped} item dilewati atau terkunci."
            )
        },
        affected_count: affected,
        reclaimed_bytes: reclaimed,
        skipped_count: skipped,
    })
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

#[tauri::command]
pub fn open_exported_cleanup_file(path: String) -> ApiResult<ActionReport> {
    let requested = normalized_path(Path::new(&path));
    let allowed_dir = normalized_path(&export_dir()?);
    if !requested.starts_with(&allowed_dir) || !requested.is_file() {
        return Err(ApiError::new(
            "EXPORT_OPEN_DENIED",
            "File export tidak berada di folder laporan LeoDisk.",
        ));
    }
    Command::new("explorer.exe")
        .arg(&requested)
        .spawn()
        .map_err(|_| ApiError::new("EXPORT_OPEN_FAILED", "File export tidak dapat dibuka."))?;
    Ok(ActionReport {
        success: true,
        message: "File export dibuka.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
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
    admin_confirmed: Option<bool>,
    admin_confirmation_phrase: Option<String>,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ActionReport> {
    let stores = stores_from_state(&state);
    let (unique, selected) = selected_cleanup_items(item_ids, &stores)?;
    delete_selected_items(
        unique,
        selected,
        permanent,
        admin_confirmed,
        admin_confirmation_phrase,
        stores,
        None,
    )
}

#[tauri::command]
pub fn start_cleanup_delete(
    item_ids: Vec<String>,
    permanent: bool,
    admin_confirmed: Option<bool>,
    admin_confirmation_phrase: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> ApiResult<ScanJob> {
    let stores = stores_from_state(&state);
    let (unique, selected) = selected_cleanup_items(item_ids, &stores)?;
    let job_id = opaque_id("cleanup-delete", &format!("{}-items", unique.len()));
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut jobs = state
        .cleanup_delete_jobs
        .lock()
        .map_err(|_| ApiError::new("CLEANUP_DELETE_LOCK", "Proses hapus tidak dapat dimulai."))?;
    if !jobs.is_empty() {
        return Err(ApiError::new(
            "CLEANUP_DELETE_ALREADY_RUNNING",
            "Proses hapus masih berjalan. Tunggu sampai selesai.",
        ));
    }
    jobs.insert(job_id.clone(), cancelled);
    let job = ScanJob {
        job_id: job_id.clone(),
        root: format!("{} item terpilih", unique.len()),
        engine: "Cleanup Delete".into(),
    };
    *state.active_cleanup_delete.lock().map_err(|_| {
        ApiError::new(
            "CLEANUP_DELETE_LOCK",
            "Status hapus cleanup tidak dapat disimpan.",
        )
    })? = Some(job.clone());
    let delete_jobs = state.cleanup_delete_jobs.clone();
    let active_cleanup_delete = state.active_cleanup_delete.clone();
    std::thread::spawn(move || {
        let context = CleanupDeleteContext::new(app.clone(), job_id.clone(), unique.len() as u64);
        let result = delete_selected_items(
            unique,
            selected,
            permanent,
            admin_confirmed,
            admin_confirmation_phrase,
            stores,
            Some(context),
        );
        match result {
            Ok(report) => {
                let _ = app.emit("cleanup-delete-complete", report);
            }
            Err(error) => {
                let _ = app.emit(
                    "cleanup-delete-error",
                    CleanupJobError {
                        job_id: job_id.clone(),
                        code: error.code,
                        message: error.message,
                    },
                );
            }
        }
        if let Ok(mut jobs) = delete_jobs.lock() {
            jobs.remove(&job_id);
        }
        if let Ok(mut active) = active_cleanup_delete.lock() {
            *active = None;
        }
    });
    Ok(job)
}

#[tauri::command]
pub fn get_active_cleanup_delete(state: tauri::State<'_, AppState>) -> ApiResult<Option<ScanJob>> {
    state
        .active_cleanup_delete
        .lock()
        .map(|active| active.clone())
        .map_err(|_| {
            ApiError::new(
                "CLEANUP_DELETE_LOCK",
                "Status hapus cleanup tidak tersedia.",
            )
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
            decision: "clean".into(),
        };
        assert!(!valid_tracked_item(&item));
    }

    #[test]
    fn report_sums_items_and_preserves_safety() {
        let report = build_report(
            vec![CleanupItem {
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
                scope: "User-level".into(),
                detected_by: "test".into(),
                detail_tags: vec!["cache".into()],
                confidence_label: "High confidence".into(),
                advisory: false,
                checked: true,
                exists: true,
                last_scanned_at: "1".into(),
                blocked_reason: None,
            }],
            "1".into(),
            "2".into(),
            1,
        );
        assert_eq!(report.total_bytes, 32);
        assert_eq!(report.total_files, 2);
        assert!(report.items[0].safe_to_delete);
        assert_eq!(report.items[0].scope, "User-level");
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
    fn expanded_roots_report_folder_children_as_delete_targets() {
        let test_dir = env::temp_dir().join(opaque_id("leodisk-test", "expanded-cleanup"));
        let child_dir = test_dir.join("nested-cache");
        let grandchild_dir = child_dir.join("deeper-cache");
        fs::create_dir_all(&grandchild_dir).expect("create nested cache");
        fs::write(test_dir.join("one.tmp"), b"cache").expect("write temp file");
        fs::write(child_dir.join("two.tmp"), b"cache-cache").expect("write nested temp file");
        fs::write(grandchild_dir.join("three.tmp"), b"cache-cache-cache")
            .expect("write deeper temp file");

        let state = AppState::default();
        let report = report_for_roots(
            vec![safe_root(
                "User Temp",
                "System Cache",
                "System Cache",
                test_dir.clone(),
                1,
                "temp",
            )],
            &state,
        )
        .expect("report expanded root");

        assert_eq!(report.items.len(), 1);
        assert!(!report.items.iter().any(|item| item.name == "one.tmp"));
        assert!(report.items.iter().any(|item| item.name == "deeper-cache"));
        assert!(!report
            .items
            .iter()
            .any(|item| item.path == path_display(&test_dir)));
        let tracked = state.deletion_items.lock().expect("tracked items");
        assert_eq!(tracked.len(), 1);
        assert!(tracked
            .values()
            .all(|item| matches!(item.mode, DeleteMode::SelfItem)));
        assert!(tracked
            .values()
            .all(|item| item.validation_root == normalized_path(&test_dir)));

        fs::remove_dir_all(test_dir).expect("cleanup test dir");
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

    #[test]
    fn admin_audit_roots_are_never_cleanable() {
        let root = admin_audit_root(
            "Windows Update Download Cache",
            "Admin Audit",
            "Protected System",
            PathBuf::from(r"C:\Windows\SoftwareDistribution\Download"),
            1,
            "shield",
            "Protected",
            "Use Windows cleanup tools.",
        );
        assert!(!root.safe_to_delete);
        assert_eq!(root.decision, "advisory");
        assert_eq!(root.scope, "Admin/system audit");
        assert!(root.detail_tags.iter().any(|tag| tag == "audit-only"));
    }

    #[test]
    fn admin_clean_root_deletes_children_only_after_confirmation() {
        let root = admin_clean_root(
            "Windows System Temp",
            "Admin Clean",
            "Protected System",
            PathBuf::from(r"C:\Windows\Temp"),
            1,
            "shield",
            "Protected",
            "Delete children only.",
        );
        assert!(!root.safe_to_delete);
        assert_eq!(root.decision, "admin");
        assert!(matches!(root.mode, DeleteMode::Children));
        assert_eq!(root.validation_root, root.path);
        assert!(root
            .detail_tags
            .iter()
            .any(|tag| tag == "confirmation-required"));
        assert!(!admin_delete_confirmed(Some(true), Some("SALAH")));
        assert!(!admin_delete_confirmed(
            Some(false),
            Some(ADMIN_CONFIRMATION_PHRASE)
        ));
        assert!(admin_delete_confirmed(
            Some(true),
            Some(ADMIN_CONFIRMATION_PHRASE)
        ));
    }
}
