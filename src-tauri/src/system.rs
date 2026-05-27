use std::cmp::Ordering;

use sysinfo::{Disks, Networks, ProcessesToUpdate, System};

use crate::{
    models::{ApiError, ApiResult, ProcessMetric, SystemSnapshot},
    windows_metrics::{battery_metric, PerformanceMetrics},
};

pub struct MonitorState {
    system: System,
    disks: Disks,
    networks: Networks,
    performance: PerformanceMetrics,
}

impl MonitorState {
    pub fn new() -> Self {
        Self {
            system: System::new_all(),
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            performance: PerformanceMetrics::new(),
        }
    }

    pub fn snapshot(&mut self) -> SystemSnapshot {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.system.refresh_processes(ProcessesToUpdate::All, true);
        self.disks.refresh(true);
        self.networks.refresh(true);

        let disk_total: u64 = self
            .disks
            .list()
            .iter()
            .map(|disk| disk.total_space())
            .sum();
        let disk_free: u64 = self
            .disks
            .list()
            .iter()
            .map(|disk| disk.available_space())
            .sum();
        let network_down_per_sec = self.networks.iter().map(|(_, data)| data.received()).sum();
        let network_up_per_sec = self
            .networks
            .iter()
            .map(|(_, data)| data.transmitted())
            .sum();
        let (gpu_percent, disk_read_per_sec, disk_write_per_sec) = self.performance.refresh();

        let mut processes: Vec<ProcessMetric> = self
            .system
            .processes()
            .iter()
            .map(|(pid, process)| ProcessMetric {
                pid: pid.as_u32(),
                name: process.name().to_string_lossy().into_owned(),
                cpu_percent: process.cpu_usage(),
                memory_bytes: process.memory(),
            })
            .collect();
        processes.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(Ordering::Equal)
        });
        processes.truncate(10);

        SystemSnapshot {
            computer_name: System::host_name().unwrap_or_else(|| "PC Windows".into()),
            os_label: System::long_os_version().unwrap_or_else(|| "Windows".into()),
            cpu_percent: self.system.global_cpu_usage(),
            memory_used: self.system.used_memory(),
            memory_total: self.system.total_memory(),
            disk_used: disk_total.saturating_sub(disk_free),
            disk_total,
            disk_read_per_sec,
            disk_write_per_sec,
            network_down_per_sec,
            network_up_per_sec,
            gpu_percent,
            battery: battery_metric(),
            uptime_seconds: System::uptime(),
            processes,
        }
    }
}

#[tauri::command]
pub fn get_system_snapshot(
    state: tauri::State<'_, crate::state::AppState>,
) -> ApiResult<SystemSnapshot> {
    let mut monitor = state
        .monitor
        .lock()
        .map_err(|_| ApiError::new("MONITOR_LOCK", "Pemantauan sistem sedang tidak tersedia."))?;
    Ok(monitor.snapshot())
}
