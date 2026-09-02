//! devtools 插桩辅助模块。
//!
//! 仅在 `devtools` feature 下编译。提供一个全局 AppHandle 引用，
//! 在 `run_translation` 开始时设置、结束时清除。
//! provider / pipeline / commands 中的 `#[cfg(feature="devtools")]` 代码
//! 通过 `dev_emit()` 向前端发送 dev-* 事件，不影响生产代码的函数签名。

#![cfg(feature = "devtools")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static EMITTER: Mutex<Option<AppHandle>> = Mutex::new(None);
/// 并行内容包时多个 run_translation 同时存活：引用计数归零才真正清除
static EMITTER_REFCOUNT: AtomicUsize = AtomicUsize::new(0);

/// 在翻译开始时调用，设置全局 emitter（引用计数 +1）。
pub fn set_emitter(handle: AppHandle) {
    EMITTER_REFCOUNT.fetch_add(1, Ordering::Relaxed);
    *EMITTER.lock().unwrap() = Some(handle);
}

/// 在翻译结束时调用，引用计数 -1，归零才清除 emitter。
pub fn clear_emitter() {
    let prev = EMITTER_REFCOUNT.fetch_sub(1, Ordering::Relaxed);
    if prev <= 1 {
        EMITTER_REFCOUNT.store(0, Ordering::Relaxed);
        *EMITTER.lock().unwrap() = None;
    }
}

/// 发送 dev-* 事件到前端。如果 emitter 未设置则静默跳过。
pub fn dev_emit<S: serde::Serialize + Clone>(event: &str, payload: S) {
    if let Ok(guard) = EMITTER.lock() {
        if let Some(handle) = guard.as_ref() {
            let _ = handle.emit(event, payload);
        }
    }
}

// ── 网络故障注入 ──────────────────────────────────────────────────────────────
#[derive(Clone, Debug)]
pub struct DevFaultConfig {
    pub delay_ms: Option<u64>,
    pub force_timeout: bool,
    pub mock_status: Option<u16>,
    pub mock_body: Option<String>,
    pub disconnect: bool,
}

impl Default for DevFaultConfig {
    fn default() -> Self {
        Self {
            delay_ms: None,
            force_timeout: false,
            mock_status: None,
            mock_body: None,
            disconnect: false,
        }
    }
}

static FAULT: Mutex<Option<DevFaultConfig>> = Mutex::new(None);

/// 设置网络故障注入配置（前端 dev_set_fault 命令调用）
pub fn set_fault(config: DevFaultConfig) {
    *FAULT.lock().unwrap() = Some(config);
}

/// 清除网络故障注入
pub fn clear_fault() {
    *FAULT.lock().unwrap() = None;
}

/// 获取当前故障配置（provider chat_inner 调用）
pub fn get_fault() -> Option<DevFaultConfig> {
    FAULT.lock().unwrap().clone()
}
