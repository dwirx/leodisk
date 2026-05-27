use std::{env, fs, path::PathBuf, process::Command};

use walkdir::WalkDir;
use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
    RegKey,
};

use crate::{
    cleanup::report_remnant_paths,
    models::{ActionReport, ApiError, ApiResult, AppSizeMeasurement, CleanupReport, InstalledApp},
    state::AppState,
    util::{normalized_path, path_display, stable_id},
};

#[derive(Clone)]
struct RegistryApp {
    public: InstalledApp,
    uninstall_string: String,
}

fn read_registry_apps() -> Vec<RegistryApp> {
    let locations = [
        (
            "HKCU",
            HKEY_CURRENT_USER,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            "HKCU32",
            HKEY_CURRENT_USER,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            "HKLM",
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            "HKLM32",
            HKEY_LOCAL_MACHINE,
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];
    let mut apps = Vec::new();
    for (scope, hive, path) in locations {
        let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        for subkey_name in root.enum_keys().filter_map(Result::ok) {
            let Ok(key) = root.open_subkey_with_flags(&subkey_name, KEY_READ) else {
                continue;
            };
            let name: String = key.get_value("DisplayName").unwrap_or_default();
            let uninstall_string: String = key.get_value("UninstallString").unwrap_or_default();
            let system_component: u32 = key.get_value("SystemComponent").unwrap_or(0);
            let release_type: String = key.get_value("ReleaseType").unwrap_or_default();
            if name.trim().is_empty()
                || system_component == 1
                || release_type.to_ascii_lowercase().contains("update")
            {
                continue;
            }
            let source_key = format!(r"{scope}\{path}\{subkey_name}");
            let estimated_kb: Option<u32> = key.get_value("EstimatedSize").ok();
            apps.push(RegistryApp {
                public: InstalledApp {
                    id: stable_id("app", &source_key),
                    name,
                    publisher: key.get_value("Publisher").unwrap_or_default(),
                    version: key.get_value("DisplayVersion").unwrap_or_default(),
                    estimated_size_bytes: estimated_kb.map(|size| size as u64 * 1024),
                    install_location: key.get_value("InstallLocation").unwrap_or_default(),
                    supported: !uninstall_string.trim().is_empty(),
                },
                uninstall_string,
            });
        }
    }
    apps.sort_by(|a, b| {
        a.public
            .name
            .to_lowercase()
            .cmp(&b.public.name.to_lowercase())
    });
    apps.dedup_by(|a, b| {
        a.public.name.eq_ignore_ascii_case(&b.public.name)
            && a.public.version.eq_ignore_ascii_case(&b.public.version)
    });
    apps
}

fn lookup_app(app_id: &str) -> ApiResult<RegistryApp> {
    read_registry_apps()
        .into_iter()
        .find(|app| app.public.id == app_id)
        .ok_or_else(|| ApiError::new("APP_NOT_FOUND", "Aplikasi tidak lagi ditemukan."))
}

fn split_command_line(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = value.trim().chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '"' => quoted = !quoted,
            ' ' | '\t' if !quoted => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
                while matches!(chars.peek(), Some(' ' | '\t')) {
                    chars.next();
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn launch_command_line(command_line: &str) -> ApiResult<()> {
    let parts = split_command_line(command_line);
    if parts.is_empty() {
        return Err(ApiError::new(
            "UNINSTALL_UNSUPPORTED",
            "Aplikasi ini tidak menyediakan command uninstaller.",
        ));
    }
    let direct = Command::new(&parts[0]).args(&parts[1..]).spawn();
    if direct.is_ok() {
        return Ok(());
    }
    Command::new("cmd")
        .args(["/C", command_line])
        .spawn()
        .map(|_| ())
        .map_err(|_| {
            ApiError::new(
                "UNINSTALL_LAUNCH_FAILED",
                "Uninstaller tidak dapat dibuka. Command dari registry tidak valid atau aplikasinya sudah berubah.",
            )
        })
}

#[tauri::command]
pub fn list_installed_apps() -> Vec<InstalledApp> {
    read_registry_apps()
        .into_iter()
        .map(|app| app.public)
        .collect()
}

#[tauri::command]
pub fn launch_uninstaller(app_id: String) -> ApiResult<ActionReport> {
    let app = lookup_app(&app_id)?;
    if !app.public.supported {
        return Err(ApiError::new(
            "UNINSTALL_UNSUPPORTED",
            "Aplikasi ini tidak menyediakan uninstaller Win32/MSI.",
        ));
    }
    launch_command_line(&app.uninstall_string)?;
    Ok(ActionReport {
        success: true,
        message: format!("Uninstaller {} telah dibuka.", app.public.name),
        affected_count: 1,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
}

#[tauri::command]
pub fn open_app_location(app_id: String) -> ApiResult<ActionReport> {
    let app = lookup_app(&app_id)?;
    let path = PathBuf::from(&app.public.install_location);
    if app.public.install_location.trim().is_empty() || !path.exists() {
        return Err(ApiError::new(
            "INSTALL_LOCATION_NOT_FOUND",
            "Lokasi instalasi aplikasi tidak tercantum atau sudah tidak ada.",
        ));
    }
    Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|_| ApiError::new("OPEN_LOCATION_FAILED", "Explorer tidak dapat dibuka."))?;
    Ok(ActionReport {
        success: true,
        message: "Lokasi instalasi dibuka di File Explorer.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
}

#[tauri::command]
pub fn measure_app_installation(app_id: String) -> ApiResult<AppSizeMeasurement> {
    let app = lookup_app(&app_id)?;
    if app.public.install_location.trim().is_empty() {
        return Err(ApiError::new(
            "INSTALL_LOCATION_NOT_FOUND",
            "Aplikasi ini tidak mencantumkan lokasi instalasi.",
        ));
    }
    let root = normalized_path(&PathBuf::from(&app.public.install_location));
    if !root.is_dir() {
        return Err(ApiError::new(
            "INSTALL_LOCATION_NOT_FOUND",
            "Lokasi instalasi aplikasi sudah tidak tersedia.",
        ));
    }
    let mut size_bytes = 0u64;
    let mut file_count = 0u64;
    let mut skipped_count = 0u64;
    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped_count += 1;
                continue;
            }
        };
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        match entry.metadata() {
            Ok(metadata) => {
                size_bytes += metadata.len();
                file_count += 1;
            }
            Err(_) => skipped_count += 1,
        }
    }
    Ok(AppSizeMeasurement {
        app_id,
        path: path_display(&root),
        size_bytes,
        file_count,
        skipped_count,
    })
}

fn comparable_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn remnant_candidates(app_name: &str) -> Vec<PathBuf> {
    let wanted = comparable_name(app_name);
    if wanted.len() < 4 {
        return Vec::new();
    }
    ["APPDATA", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(|variable| env::var(variable).ok())
        .flat_map(|root| {
            fs::read_dir(root)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect::<Vec<_>>()
        })
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| comparable_name(name) == wanted)
                .unwrap_or(false)
        })
        .collect()
}

#[tauri::command]
pub fn scan_app_remnants(
    app_id: String,
    state: tauri::State<'_, AppState>,
) -> ApiResult<CleanupReport> {
    let app = lookup_app(&app_id)?;
    report_remnant_paths(
        format!("Sisa {}", app.public.name),
        remnant_candidates(&app.public.name),
        &state,
    )
}

#[cfg(test)]
mod tests {
    use super::{comparable_name, split_command_line};

    #[test]
    fn remnant_matching_is_case_and_separator_independent() {
        assert_eq!(comparable_name("Leo Disk"), comparable_name("LEO-DISK"));
    }

    #[test]
    fn uninstall_command_parser_keeps_quoted_executable_and_args() {
        assert_eq!(
            split_command_line(r#""C:\Program Files\App\uninstall.exe" /uninstall /quiet"#),
            vec![
                r"C:\Program Files\App\uninstall.exe",
                "/uninstall",
                "/quiet"
            ]
        );
        assert_eq!(
            split_command_line(r#"MsiExec.exe /I{ABC-123}"#),
            vec!["MsiExec.exe", "/I{ABC-123}"]
        );
    }
}
