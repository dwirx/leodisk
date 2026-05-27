use std::{env, fs, process::Command};

use winreg::{
    enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ},
    RegKey, HKEY,
};

use crate::models::{ActionReport, ApiError, ApiResult, StartupItem};

fn registry_items(label: &str, hive: HKEY) -> Vec<StartupItem> {
    let Ok(key) = RegKey::predef(hive)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", KEY_READ)
    else {
        return Vec::new();
    };
    key.enum_values()
        .filter_map(Result::ok)
        .filter_map(|(name, _)| {
            key.get_value::<String, _>(&name)
                .ok()
                .map(|command| StartupItem {
                    name,
                    command,
                    source: label.to_string(),
                    enabled: true,
                })
        })
        .collect()
}

fn folder_items(label: &str, path: std::path::PathBuf) -> Vec<StartupItem> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| StartupItem {
            name: entry.file_name().to_string_lossy().into_owned(),
            command: entry.path().to_string_lossy().into_owned(),
            source: label.to_string(),
            enabled: true,
        })
        .collect()
}

#[tauri::command]
pub fn list_startup_items() -> Vec<StartupItem> {
    let mut items = registry_items("Registry pengguna", HKEY_CURRENT_USER);
    items.extend(registry_items("Registry sistem", HKEY_LOCAL_MACHINE));
    if let Ok(appdata) = env::var("APPDATA") {
        items.extend(folder_items(
            "Folder Startup pengguna",
            std::path::PathBuf::from(appdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\Startup"),
        ));
    }
    if let Ok(programdata) = env::var("PROGRAMDATA") {
        items.extend(folder_items(
            "Folder Startup sistem",
            std::path::PathBuf::from(programdata)
                .join(r"Microsoft\Windows\Start Menu\Programs\StartUp"),
        ));
    }
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items
}

#[tauri::command]
pub fn open_startup_settings() -> ApiResult<ActionReport> {
    Command::new("explorer.exe")
        .arg("ms-settings:startupapps")
        .spawn()
        .map_err(|_| {
            ApiError::new(
                "SETTINGS_LAUNCH_FAILED",
                "Pengaturan Startup Windows tidak dapat dibuka.",
            )
        })?;
    Ok(ActionReport {
        success: true,
        message: "Pengaturan Startup Windows dibuka.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
}
