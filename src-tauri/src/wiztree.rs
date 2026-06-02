use std::{
    env, fs,
    io::{self, Cursor},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::Manager;

use crate::{
    models::{ApiError, ApiResult},
    util::path_display,
};

pub const WIZTREE_VERSION: &str = "4.31";
pub const WIZTREE_DOWNLOAD_URL: &str = "https://diskanalyzer.com/files/wiztree_4_31_portable.zip";
const PORTABLE_DIR: &str = "wiztree_4_31_portable";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WizTreeStatus {
    pub available: bool,
    pub verified: bool,
    pub executable_path: Option<String>,
    pub install_dir: String,
    pub version: String,
    pub download_url: String,
    pub message: String,
    pub last_error: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(target_pointer_width = "64") {
        "WizTree64.exe"
    } else {
        "WizTree.exe"
    }
}

fn manifest_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
}

pub fn install_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| env::temp_dir().join("LeoDisk"))
        .join(PORTABLE_DIR)
}

pub fn cache_path(app: &tauri::AppHandle, file_name: &str) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| env::temp_dir().join("LeoDisk"))
        .join(file_name)
}

fn candidate_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut candidates = vec![install_dir(app)];
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(PORTABLE_DIR));
    }
    if let Some(root) = manifest_root() {
        candidates.push(root.join(PORTABLE_DIR));
    }
    if let Ok(current) = env::current_dir() {
        candidates.push(current.join(PORTABLE_DIR));
        if let Some(parent) = current.parent() {
            candidates.push(parent.join(PORTABLE_DIR));
        }
    }
    candidates
}

pub fn executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    candidate_dirs(app)
        .into_iter()
        .map(|dir| dir.join(exe_name()))
        .find(|path| path.is_file())
}

pub fn command(exe: &Path) -> Command {
    let mut command = Command::new(exe);
    if let Some(parent) = exe.parent() {
        command.current_dir(parent);
    }
    command
}

pub fn cli_args(_app: &tauri::AppHandle, export_path: &Path) -> Vec<String> {
    vec![
        format!("/export={}", path_display(export_path)),
        "/admin=0".into(),
        "/exportfolders=1".into(),
        "/exportfiles=1".into(),
        "/sortby=2".into(),
    ]
}

pub fn status(app: &tauri::AppHandle) -> WizTreeStatus {
    let executable_path = executable(app);
    WizTreeStatus {
        available: executable_path.is_some(),
        verified: false,
        executable_path: executable_path.as_ref().map(|path| path_display(path)),
        install_dir: path_display(&install_dir(app)),
        version: WIZTREE_VERSION.into(),
        download_url: WIZTREE_DOWNLOAD_URL.into(),
        message: if executable_path.is_some() {
            "WizTree portable terdeteksi. Jalankan uji WizTree untuk memastikan CLI export bekerja."
                .into()
        } else {
            "WizTree portable belum ditemukan. Gunakan tombol download untuk memasang portable resmi.".into()
        },
        last_error: None,
    }
}

fn status_with_result(app: &tauri::AppHandle, result: ApiResult<()>) -> WizTreeStatus {
    let mut status = status(app);
    match result {
        Ok(()) => {
            status.verified = true;
            status.message = "WizTree portable berhasil diuji dan siap untuk scan CSV.".into();
            status.last_error = None;
        }
        Err(error) => {
            status.verified = false;
            status.message = "WizTree portable terdeteksi, tetapi uji CLI export gagal.".into();
            status.last_error = Some(format!("{} ({})", error.message, error.code));
        }
    }
    status
}

pub fn verify(app: &tauri::AppHandle) -> ApiResult<()> {
    let exe = executable(app).ok_or_else(|| {
        ApiError::new(
            "WIZTREE_NOT_FOUND",
            "WizTree portable belum ditemukan. Download portable resmi terlebih dahulu.",
        )
    })?;
    let smoke_root = cache_path(app, "wiztree-smoke-root");
    let smoke_file = smoke_root.join("leodisk-wiztree-probe.txt");
    let smoke_csv = cache_path(app, "leodisk-wiztree-health-check.csv");
    fs::create_dir_all(&smoke_root).map_err(|error| {
        io_error(
            "WIZTREE_PREFLIGHT_ROOT_FAILED",
            "Folder uji WizTree tidak dapat dibuat",
            error,
        )
    })?;
    fs::write(&smoke_file, b"leodisk-wiztree-health-check").map_err(|error| {
        io_error(
            "WIZTREE_PREFLIGHT_FILE_FAILED",
            "File uji WizTree tidak dapat dibuat",
            error,
        )
    })?;
    let _ = fs::remove_file(&smoke_csv);
    let mut command = command(&exe);
    command.arg(path_display(&smoke_root));
    for arg in cli_args(app, &smoke_csv) {
        command.arg(arg);
    }
    let mut child = command.spawn().map_err(|error| {
        io_error(
            "WIZTREE_PREFLIGHT_START_FAILED",
            "WizTree CLI tidak dapat dijalankan untuk uji awal",
            error,
        )
    })?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(status)) => {
                return Err(ApiError::new(
                    "WIZTREE_PREFLIGHT_EXIT_FAILED",
                    format!(
                        "WizTree uji awal berhenti dengan exit code {:?}.",
                        status.code()
                    ),
                ));
            }
            Ok(None) if started.elapsed() >= Duration::from_secs(20) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ApiError::new(
                    "WIZTREE_PREFLIGHT_TIMEOUT",
                    "WizTree tidak menyelesaikan uji awal dalam 20 detik. Kemungkinan ada dialog error atau proses macet.",
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(250)),
            Err(error) => {
                return Err(io_error(
                    "WIZTREE_PREFLIGHT_WAIT_FAILED",
                    "Status proses uji WizTree tidak dapat dibaca",
                    error,
                ));
            }
        }
    }
    let content = fs::read_to_string(&smoke_csv).map_err(|error| {
        io_error(
            "WIZTREE_PREFLIGHT_CSV_MISSING",
            "CSV hasil uji WizTree tidak dapat dibaca",
            error,
        )
    })?;
    if !content.contains("File Name")
        || !content
            .to_ascii_lowercase()
            .contains("leodisk-wiztree-probe.txt")
    {
        return Err(ApiError::new(
            "WIZTREE_PREFLIGHT_CSV_INVALID",
            "CSV hasil uji WizTree tidak berisi header atau file probe LeoDisk.",
        ));
    }
    Ok(())
}

fn zip_error(error: zip::result::ZipError) -> ApiError {
    ApiError::new(
        "WIZTREE_ZIP_FAILED",
        format!("Portable WizTree tidak dapat diekstrak: {error}"),
    )
}

fn io_error(code: &str, message: &str, error: io::Error) -> ApiError {
    ApiError::new(code, format!("{message}: {error}"))
}

#[tauri::command]
pub fn get_wiztree_status(app: tauri::AppHandle) -> ApiResult<WizTreeStatus> {
    Ok(status(&app))
}

#[tauri::command]
pub fn verify_wiztree_status(app: tauri::AppHandle) -> ApiResult<WizTreeStatus> {
    Ok(status_with_result(&app, verify(&app)))
}

#[tauri::command]
pub fn install_wiztree_portable(app: tauri::AppHandle) -> ApiResult<WizTreeStatus> {
    let install_dir = install_dir(&app);
    fs::create_dir_all(&install_dir).map_err(|error| {
        io_error(
            "WIZTREE_INSTALL_DIR_FAILED",
            "Folder instalasi WizTree tidak dapat dibuat",
            error,
        )
    })?;
    let response = reqwest::blocking::get(WIZTREE_DOWNLOAD_URL).map_err(|error| {
        ApiError::new(
            "WIZTREE_DOWNLOAD_FAILED",
            format!("Download portable WizTree gagal: {error}"),
        )
    })?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            "WIZTREE_DOWNLOAD_FAILED",
            format!("Server WizTree mengembalikan status {}.", response.status()),
        ));
    }
    let bytes = response.bytes().map_err(|error| {
        ApiError::new(
            "WIZTREE_DOWNLOAD_FAILED",
            format!("Portable WizTree tidak dapat dibaca dari response: {error}"),
        )
    })?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(zip_error)?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(zip_error)?;
        let Some(enclosed) = file.enclosed_name() else {
            continue;
        };
        let relative = enclosed
            .strip_prefix(PORTABLE_DIR)
            .unwrap_or(&enclosed)
            .to_path_buf();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let output_path = install_dir.join(relative);
        if file.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                io_error(
                    "WIZTREE_EXTRACT_FAILED",
                    "Folder WizTree tidak dapat dibuat",
                    error,
                )
            })?;
            continue;
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                io_error(
                    "WIZTREE_EXTRACT_FAILED",
                    "Folder WizTree tidak dapat dibuat",
                    error,
                )
            })?;
        }
        let mut output = fs::File::create(&output_path).map_err(|error| {
            io_error(
                "WIZTREE_EXTRACT_FAILED",
                "File WizTree tidak dapat dibuat",
                error,
            )
        })?;
        io::copy(&mut file, &mut output).map_err(|error| {
            io_error(
                "WIZTREE_EXTRACT_FAILED",
                "File WizTree tidak dapat diekstrak",
                error,
            )
        })?;
    }
    let status = status(&app);
    if !status.available {
        return Err(ApiError::new(
            "WIZTREE_INSTALL_INCOMPLETE",
            "Download selesai, tetapi WizTree64.exe belum ditemukan setelah ekstraksi.",
        ));
    }
    Ok(status)
}
