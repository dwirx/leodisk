mod apps;
mod cleanup;
mod disk_scan;
mod models;
mod purge;
mod startup;
mod state;
mod storage;
mod system;
mod util;
mod windows_metrics;
mod wiztree;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            system::get_system_snapshot,
            cleanup::scan_cleanup,
            cleanup::scan_deep_cleanup,
            cleanup::start_cleanup_scan,
            cleanup::get_active_cleanup_scan,
            cleanup::cancel_cleanup_scan,
            cleanup::delete_cleanup_items,
            cleanup::start_cleanup_delete,
            cleanup::get_active_cleanup_delete,
            cleanup::open_scanned_location,
            cleanup::export_cleanup_report,
            cleanup::export_cleanup_metafile,
            cleanup::export_cleanup_detail,
            cleanup::open_exported_cleanup_file,
            apps::list_installed_apps,
            apps::launch_uninstaller,
            apps::open_app_location,
            apps::measure_app_installation,
            apps::scan_app_remnants,
            purge::scan_project_artifacts,
            purge::scan_installers,
            startup::list_startup_items,
            startup::open_startup_settings,
            storage::list_storage_volumes,
            storage::open_storage_settings,
            disk_scan::get_active_disk_scan,
            disk_scan::start_disk_scan,
            disk_scan::cancel_disk_scan,
            wiztree::get_wiztree_status,
            wiztree::verify_wiztree_status,
            wiztree::install_wiztree_portable
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
