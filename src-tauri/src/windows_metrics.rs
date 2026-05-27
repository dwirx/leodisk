use windows::{
    core::{w, PCWSTR},
    Win32::System::{
        Performance::{
            PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
            PdhGetFormattedCounterArrayW, PdhGetFormattedCounterValue, PdhOpenQueryW,
            PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE,
            PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
        },
        Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
    },
};

use crate::models::BatteryMetric;

const ERROR_SUCCESS: u32 = 0;

pub struct PerformanceMetrics {
    query: Option<PDH_HQUERY>,
    gpu: Option<PDH_HCOUNTER>,
    disk_read: Option<PDH_HCOUNTER>,
    disk_write: Option<PDH_HCOUNTER>,
}

unsafe impl Send for PerformanceMetrics {}

impl PerformanceMetrics {
    pub fn new() -> Self {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != ERROR_SUCCESS {
                return Self::unavailable();
            }
            let gpu = add_counter(query, w!(r"\GPU Engine(*)\Utilization Percentage"));
            let disk_read = add_counter(query, w!(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec"));
            let disk_write = add_counter(query, w!(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec"));
            let _ = PdhCollectQueryData(query);
            Self {
                query: Some(query),
                gpu,
                disk_read,
                disk_write,
            }
        }
    }

    fn unavailable() -> Self {
        Self {
            query: None,
            gpu: None,
            disk_read: None,
            disk_write: None,
        }
    }

    pub fn refresh(&mut self) -> (Option<f64>, Option<f64>, Option<f64>) {
        let Some(query) = self.query else {
            return (None, None, None);
        };
        unsafe {
            if PdhCollectQueryData(query) != ERROR_SUCCESS {
                return (None, None, None);
            }
            (
                self.gpu.and_then(|counter| wildcard_max(counter)),
                self.disk_read.and_then(|counter| scalar_value(counter)),
                self.disk_write.and_then(|counter| scalar_value(counter)),
            )
        }
    }
}

impl Drop for PerformanceMetrics {
    fn drop(&mut self) {
        if let Some(query) = self.query {
            unsafe {
                let _ = PdhCloseQuery(query);
            }
        }
    }
}

unsafe fn add_counter(query: PDH_HQUERY, path: PCWSTR) -> Option<PDH_HCOUNTER> {
    let mut counter = PDH_HCOUNTER::default();
    (PdhAddEnglishCounterW(query, path, 0, &mut counter) == ERROR_SUCCESS).then_some(counter)
}

unsafe fn scalar_value(counter: PDH_HCOUNTER) -> Option<f64> {
    let mut value = PDH_FMT_COUNTERVALUE::default();
    if PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value) != ERROR_SUCCESS {
        return None;
    }
    valid_value(&value)
}

unsafe fn wildcard_max(counter: PDH_HCOUNTER) -> Option<f64> {
    let mut bytes = 0;
    let mut count = 0;
    let first = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut bytes, &mut count, None);
    if first != PDH_MORE_DATA || count == 0 {
        return None;
    }
    let unit = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>() as u32;
    let capacity = bytes.div_ceil(unit).max(count) as usize;
    let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); capacity];
    if PdhGetFormattedCounterArrayW(
        counter,
        PDH_FMT_DOUBLE,
        &mut bytes,
        &mut count,
        Some(items.as_mut_ptr()),
    ) != ERROR_SUCCESS
    {
        return None;
    }
    items
        .iter()
        .take(count as usize)
        .filter_map(|item| valid_value(&item.FmtValue))
        .reduce(f64::max)
        .map(|value| value.clamp(0.0, 100.0))
}

unsafe fn valid_value(value: &PDH_FMT_COUNTERVALUE) -> Option<f64> {
    if value.CStatus == PDH_CSTATUS_VALID_DATA || value.CStatus == PDH_CSTATUS_NEW_DATA {
        let parsed = value.Anonymous.doubleValue;
        parsed.is_finite().then_some(parsed.max(0.0))
    } else {
        None
    }
}

pub fn battery_metric() -> Option<BatteryMetric> {
    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        GetSystemPowerStatus(&mut status).ok()?;
        if status.BatteryFlag == 128 || status.BatteryLifePercent == 255 {
            return None;
        }
        Some(BatteryMetric {
            percent: status.BatteryLifePercent,
            charging: status.ACLineStatus == 1,
            seconds_remaining: (status.BatteryLifeTime != u32::MAX)
                .then_some(status.BatteryLifeTime),
        })
    }
}
