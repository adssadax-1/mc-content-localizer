//! devtools 插桩辅助模块。
//!
//! 仅在 `devtools` feature 下编译。提供一个全局 AppHandle 引用，
//! 在 `run_translation` 开始时设置、结束时清除。
//! provider / pipeline / commands 中的 `#[cfg(feature="devtools")]` 代码
//! 通过 `dev_emit()` 向前端发送 dev-* 事件，不影响生产代码的函数签名。

#![cfg(feature = "devtools")]

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// emitter 句柄 + 存活计数放在同一把锁内。
/// 此前计数用独立原子变量，与句柄写入/清除不在同一临界区：并行翻译时
/// 「A 减计数」与「B 写句柄」交错会把 B 刚设置的句柄清掉，导致 B 这个
/// 内容包整包 dev-* 事件全部丢失（表现为「翻译完了却没有计入」）。
struct EmitterSlot {
    handle: Option<AppHandle>,
    refcount: usize,
}

static EMITTER: Mutex<EmitterSlot> = Mutex::new(EmitterSlot {
    handle: None,
    refcount: 0,
});

/// 在翻译开始时调用，设置全局 emitter（引用计数 +1）。
pub fn set_emitter(handle: AppHandle) {
    if let Ok(mut slot) = EMITTER.lock() {
        slot.handle = Some(handle);
        slot.refcount += 1;
    }
}

/// 在翻译结束时调用，引用计数 -1，归零才清除 emitter。
pub fn clear_emitter() {
    if let Ok(mut slot) = EMITTER.lock() {
        if slot.refcount > 0 {
            slot.refcount -= 1;
        }
        if slot.refcount == 0 {
            slot.handle = None;
        }
    }
}

/// 发送 dev-* 事件到前端。如果 emitter 未设置则静默跳过。
pub fn dev_emit<S: serde::Serialize + Clone>(event: &str, payload: S) {
    // 取出句柄副本后立即释放锁，避免 emit 期间持锁阻塞其它内容包的插桩
    let handle = match EMITTER.lock() {
        Ok(slot) => slot.handle.clone(),
        Err(_) => None,
    };
    if let Some(handle) = handle {
        let _ = handle.emit(event, payload);
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
