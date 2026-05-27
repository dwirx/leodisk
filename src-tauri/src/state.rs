use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc, Mutex},
};

use crate::system::MonitorState;

#[derive(Debug, Clone, Copy)]
pub enum DeleteMode {
    Children,
    SelfItem,
}

#[derive(Debug, Clone)]
pub struct TrackedDeletion {
    pub path: PathBuf,
    pub validation_root: PathBuf,
    pub mode: DeleteMode,
    pub estimated_bytes: u64,
}

pub struct AppState {
    pub monitor: Mutex<MonitorState>,
    pub deletion_items: Arc<Mutex<HashMap<String, TrackedDeletion>>>,
    pub known_locations: Arc<Mutex<HashMap<String, PathBuf>>>,
    pub disk_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            monitor: Mutex::new(MonitorState::new()),
            deletion_items: Arc::new(Mutex::new(HashMap::new())),
            known_locations: Arc::new(Mutex::new(HashMap::new())),
            disk_jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
