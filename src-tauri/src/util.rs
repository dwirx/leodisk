use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn opaque_id(prefix: &str, value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!(
        "{}-{:x}-{}",
        prefix,
        hasher.finish(),
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    )
}

pub fn stable_id(prefix: &str, value: &str) -> String {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{}-{:x}", prefix, hasher.finish())
}

pub fn normalized_path(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

pub fn path_display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
