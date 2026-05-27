use std::{env, process::Command};

use sysinfo::{DiskKind, Disks};

use crate::{
    models::{ActionReport, ApiError, ApiResult, StorageSettingsDestination, StorageVolume},
    util::{opaque_id, path_display},
};

fn disk_kind_label(kind: DiskKind) -> String {
    match kind {
        DiskKind::SSD => "SSD".into(),
        DiskKind::HDD => "HDD".into(),
        _ => "Tidak diketahui".into(),
    }
}

#[tauri::command]
pub fn list_storage_volumes() -> Vec<StorageVolume> {
    let system_drive = env::var("SystemDrive")
        .unwrap_or_else(|_| "C:".into())
        .to_ascii_lowercase();
    let disks = Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .map(|disk| {
            let root = path_display(disk.mount_point());
            let root_lower = root.to_ascii_lowercase();
            StorageVolume {
                id: opaque_id("volume", &root),
                label: disk.name().to_string_lossy().into_owned(),
                root: root.clone(),
                filesystem: disk.file_system().to_string_lossy().into_owned(),
                kind: disk_kind_label(disk.kind()),
                total_bytes: disk.total_space(),
                available_bytes: disk.available_space(),
                is_system: root_lower.starts_with(&system_drive),
                is_removable: disk.is_removable(),
                is_read_only: disk.is_read_only(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn open_storage_settings(destination: StorageSettingsDestination) -> ApiResult<ActionReport> {
    let uri = match destination {
        StorageSettingsDestination::Storage => "ms-settings:storagesense",
        StorageSettingsDestination::Recommendations => "ms-settings:storagerecommendations",
        StorageSettingsDestination::Volumes => "ms-settings:disksandvolumes",
    };
    Command::new("cmd")
        .args(["/C", "start", "", uri])
        .spawn()
        .map_err(|_| {
            ApiError::new(
                "STORAGE_SETTINGS_FAILED",
                "Pengaturan penyimpanan Windows tidak dapat dibuka.",
            )
        })?;
    Ok(ActionReport {
        success: true,
        message: "Pengaturan penyimpanan Windows dibuka.".into(),
        affected_count: 0,
        reclaimed_bytes: 0,
        skipped_count: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::disk_kind_label;
    use sysinfo::DiskKind;

    #[test]
    fn disk_kind_labels_are_user_facing() {
        assert_eq!(disk_kind_label(DiskKind::SSD), "SSD");
        assert_eq!(disk_kind_label(DiskKind::HDD), "HDD");
    }
}
