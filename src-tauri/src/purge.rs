use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use crate::{
    cleanup::report_review_paths,
    models::{ApiResult, CleanupReport},
    state::AppState,
    util::{normalized_path, path_display},
};

const PROJECT_SCAN_DEPTH: usize = 6;
const INSTALLER_SCAN_DEPTH: usize = 2;
const INSTALLER_MIN_BYTES: u64 = 10 * 1024 * 1024;

fn artifact_category(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "node_modules" => Some("JS dependencies"),
        "target" => Some("Rust build target"),
        "dist" | "build" => Some("Build output"),
        ".next" | ".turbo" | ".cache" => Some("Build cache"),
        "coverage" => Some("Test coverage"),
        "venv" | ".venv" => Some("Python environment"),
        "__pycache__" => Some("Python bytecode cache"),
        _ => None,
    }
}

fn installer_category(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "exe" | "msi" | "msix" | "appx" => Some("Installer Windows"),
        "zip" | "7z" | "rar" => Some("Arsip installer"),
        "iso" => Some("Image installer"),
        _ => None,
    }
}

fn user_dir(name: &str) -> Option<PathBuf> {
    env::var("USERPROFILE")
        .ok()
        .map(|home| PathBuf::from(home).join(name))
}

fn default_project_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        for child in [
            "Developments",
            "Development",
            "Projects",
            "repos",
            "source",
            "Documents",
            "Desktop",
            "Downloads",
        ] {
            let path = home.join(child);
            if path.is_dir() {
                roots.push(path);
            }
        }
    }
    roots
}

fn default_installer_roots() -> Vec<PathBuf> {
    ["Downloads", "Desktop"]
        .into_iter()
        .filter_map(user_dir)
        .filter(|path| path.is_dir())
        .collect()
}

fn scan_artifact_dir(
    directory: &Path,
    depth: usize,
    output: &mut Vec<(String, PathBuf, String)>,
    seen: &mut HashSet<String>,
) {
    if depth > PROJECT_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Some(category) = artifact_category(name) {
            let path = normalized_path(&path);
            if seen.insert(path_display(&path).to_ascii_lowercase()) {
                output.push((
                    category.into(),
                    path,
                    "Artefak proyek dapat dibuat ulang, tetapi hapus hanya bila proyek tidak sedang dipakai.".into(),
                ));
            }
            continue;
        }
        scan_artifact_dir(&path, depth + 1, output, seen);
    }
}

fn scan_installer_dir(
    directory: &Path,
    depth: usize,
    output: &mut Vec<(String, PathBuf, String)>,
    seen: &mut HashSet<String>,
) {
    if depth > INSTALLER_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            scan_installer_dir(&path, depth + 1, output, seen);
            continue;
        }
        if !metadata.is_file() || metadata.len() < INSTALLER_MIN_BYTES {
            continue;
        }
        if let Some(category) = installer_category(&path) {
            let path = normalized_path(&path);
            if seen.insert(path_display(&path).to_ascii_lowercase()) {
                output.push((
                    category.into(),
                    path,
                    "File installer atau arsip besar. Pastikan tidak dibutuhkan sebelum dihapus."
                        .into(),
                ));
            }
        }
    }
}

#[tauri::command]
pub fn scan_project_artifacts(
    paths: Option<Vec<String>>,
    state: tauri::State<'_, AppState>,
) -> ApiResult<CleanupReport> {
    let roots = paths
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    let roots = if roots.is_empty() {
        default_project_roots()
    } else {
        roots
    };
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for root in roots {
        scan_artifact_dir(&root, 0, &mut candidates, &mut seen);
    }
    report_review_paths(candidates, &state)
}

#[tauri::command]
pub fn scan_installers(state: tauri::State<'_, AppState>) -> ApiResult<CleanupReport> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for root in default_installer_roots() {
        scan_installer_dir(&root, 0, &mut candidates, &mut seen);
    }
    report_review_paths(candidates, &state)
}

#[cfg(test)]
mod tests {
    use super::{artifact_category, installer_category};
    use std::path::Path;

    #[test]
    fn detects_project_artifact_names() {
        assert_eq!(artifact_category("node_modules"), Some("JS dependencies"));
        assert_eq!(artifact_category("target"), Some("Rust build target"));
        assert_eq!(artifact_category(".venv"), Some("Python environment"));
        assert_eq!(artifact_category("src"), None);
    }

    #[test]
    fn detects_installer_extensions_only() {
        assert_eq!(
            installer_category(Path::new(r"C:\Users\a\Downloads\setup.msi")),
            Some("Installer Windows")
        );
        assert_eq!(
            installer_category(Path::new(r"C:\Users\a\Downloads\image.iso")),
            Some("Image installer")
        );
        assert_eq!(installer_category(Path::new("notes.txt")), None);
    }
}
