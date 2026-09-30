//! 会话日志：应用运行期自动记录 INFO/WARN/ERROR 到内存缓冲（供「日志」页查看/筛选）
//! 与磁盘文件（供「打开日志文件夹」/崩溃后排查）。
//!
//! 设计约束（与现有架构对齐，不建第二套系统）：
//! - 目录固定为 `app_config_dir/logs/`（受 storage.rs 的标识符护栏约束，与设置同根）；
//! - 一个应用会话（启动→退出）一个文件 `session-YYYYMMDD-HHMMSS.log`，不做轮转/归档；
//! - 「自动记录日志」关闭：内存与文件都**不再追加**，已有内容原样保留；
//! - 「清除数据（勾选日志）」/「清除日志」删除文件后，日志器继续可用（下次写时重建文件）；
//! - 敏感信息在写入前统一脱敏：注册的 API Key 精确替换 + Bearer/Authorization/api_key 模式；
//! - 内存缓冲上限 2000 条（超出丢最旧），避免长会话占用无界增长；
//! - 时间戳一律**本地时间**（见下方 TZ_OFFSET_MIN：偏移由界面启动时告知）。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

/// 内存缓冲上限：超出丢弃最旧条目（UI 页与导出都以此为准）
const BUFFER_CAP: usize = 2000;
/// 单条密钥参与精确替换的最小长度（太短的子串易误伤正常文本）
const SECRET_MIN_LEN: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// HH:MM:SS（会话内时间，文件头部另有完整日期）
    pub time: String,
    /// info / warn / error
    pub level: String,
    pub message: String,
}

static ENABLED: AtomicBool = AtomicBool::new(true);
static FILE_OK: AtomicBool = AtomicBool::new(true);
static LOGS_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static SESSION_FILE: Mutex<Option<String>> = Mutex::new(None);
static BUFFER: Mutex<VecDeque<LogEntry>> = Mutex::new(VecDeque::new());
static SECRETS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 本地时区偏移（分钟，东八区 = 480），`UNKNOWN_TZ` = 尚未得知。
///
/// 为什么不让 Rust 自己算：本项目刻意不引入 chrono / time（依赖树里本来没有，
/// 加进来要真编译一遍），而 `std` 拿不到本地时区 —— `SystemTime` 只有 UTC。
/// 界面侧 `new Date().getTimezoneOffset()` 就是权威值，启动时报一次即可。
/// 报之前写入的条目按 UTC（实际只可能是启动瞬间那一两条），报之后全部本地时间。
const UNKNOWN_TZ: i64 = i64::MIN;
static TZ_OFFSET_MIN: AtomicI64 = AtomicI64::new(UNKNOWN_TZ);

/// 「会话开始」那一行：init 时备好文案，等时区已知（或第一条日志到来）再落下。
/// 若在 init 里直接写，它会变成全文件唯一一行 UTC 时间，与下面所有行差一个时区。
static START_LINE: Mutex<Option<String>> = Mutex::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);

/// ── 时间格式化：无 chrono/time 依赖，用 Howard Hinnant 的 civil_from_days 算法 ──
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn now_parts() -> (String, String) {
    let mut secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let tz = TZ_OFFSET_MIN.load(Ordering::Relaxed);
    if tz != UNKNOWN_TZ {
        secs += tz * 60;
    }
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!("{:02}:{:02}:{:02}", rem / 3600, (rem % 3600) / 60, rem % 60),
    )
}

/// 敏感信息脱敏：注册的密钥精确替换 + 常见认证模式（不依赖调用方自觉）。
fn redact(msg: &str) -> String {
    let mut out = msg.to_string();
    if let Ok(secrets) = SECRETS.lock() {
        for s in secrets.iter() {
            if s.len() >= SECRET_MIN_LEN && out.contains(s.as_str()) {
                out = out.replace(s.as_str(), "***");
            }
        }
    }
    static BEARER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static AUTH_HEADER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static API_KEY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let bearer = BEARER.get_or_init(|| regex::Regex::new(r"(?i)(bearer\s+)\S+").unwrap());
    let auth = AUTH_HEADER.get_or_init(|| regex::Regex::new(r"(?i)(authorization\s*[:=]\s*)\S+").unwrap());
    let key = API_KEY.get_or_init(|| regex::Regex::new(r"(?i)(api[_-]?key\s*[:=]\s*)\S+").unwrap());
    let out = bearer.replace_all(&out, "${1}***");
    let out = auth.replace_all(&out, "${1}***");
    key.replace_all(&out, "${1}***").into_owned()
}

/// 启动时调用：定位日志目录、应用开关与密钥表、写会话头。
pub fn init(app: &tauri::AppHandle, settings: &crate::settings::Settings) {
    let dir = app
        .path()
        .app_config_dir()
        .map(|p| p.join("logs"))
        .unwrap_or_else(|_| std::env::temp_dir().join("mc-content-localizer-logs"));
    if let Ok(mut slot) = LOGS_DIR.lock() {
        *slot = Some(dir.clone());
    }
    set_enabled(settings.auto_log);
    set_secrets(
        std::iter::once(settings.provider.api_key.clone())
            .chain(settings.provider_api_keys.values().cloned()),
    );
    // 会话文件名**不在这里定**：时区是界面报上来的，此刻算出来会是 UTC 名字
    // （文件里却是本地时间，对不上）。改成第一次真正写日志时才命名 —— 见 session_file()。
    // 「会话开始」同理：备好文案，等时区已知（或第一条日志到来）再落这行，
    // 让"会话开始"与后续行用同一种时间基准。
    if let Ok(mut slot) = START_LINE.lock() {
        *slot = Some(format!(
            "MC汉化工坊 v{} 会话开始（自动记录日志：{}）",
            env!("CARGO_PKG_VERSION"),
            if settings.auto_log { "开" } else { "关" }
        ));
    }
}

/// 本次会话的日志文件名，命名一次后固定。
/// 延迟到这里（第一条日志落盘时）才算，是为了拿到界面报来的时区 ——
/// 否则名字会是 UTC 时间，与文件内的时间戳对不上。
fn session_file() -> Option<String> {
    if let Ok(s) = SESSION_FILE.lock() {
        if let Some(n) = s.as_ref() {
            return Some(n.clone());
        }
    }
    let (d, t) = now_parts();
    let name = format!("session-{}-{}.log", d.replace('-', ""), t.replace(':', ""));
    if let Ok(mut s) = SESSION_FILE.lock() {
        *s = Some(name.clone());
    }
    Some(name)
}

/// 把备好的「会话开始」落下去（只落一次）。在 write() 开头与设置时区时调用。
fn ensure_start() {
    if STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let line = START_LINE.lock().ok().and_then(|mut s| s.take());
    if let Some(msg) = line {
        write("info", &msg);
    }
}

/// 「自动记录日志」开关。返回是否发生变更（供设置保存处记录一条日志）。
pub fn set_enabled(on: bool) -> bool {
    ENABLED.swap(on, Ordering::Relaxed) != on
}

/// 注册需要精确脱敏的密钥（当前 provider 的 key + 各服务商保存的 key）。
pub fn set_secrets<I: Iterator<Item = String>>(secrets: I) {
    if let Ok(mut slot) = SECRETS.lock() {
        *slot = secrets
            .filter(|s| s.len() >= SECRET_MIN_LEN)
            .collect::<Vec<_>>()
            .into_iter()
            .collect();
        slot.sort();
        slot.dedup();
    }
}

pub fn info(msg: &str) {
    write("info", msg);
}
pub fn warn(msg: &str) {
    write("warn", msg);
}
pub fn error(msg: &str) {
    write("error", msg);
}

/// 唯一的写入路径：脱敏 → 内存缓冲（cap）→ 开启时追加会话文件。
fn write(level: &str, msg: &str) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    // 第一条真正的日志之前，先把「会话开始」补上（STARTED 已翻转，不会递归）
    ensure_start();
    let (_d, time) = now_parts();
    let entry = LogEntry {
        time,
        level: level.to_string(),
        message: redact(msg),
    };
    if let Ok(mut buf) = BUFFER.lock() {
        if buf.len() >= BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(entry.clone());
    }
    append_file(&entry);
}

fn append_file(entry: &LogEntry) {
    if !FILE_OK.load(Ordering::Relaxed) {
        return;
    }
    let (dir, file) = {
        let d = LOGS_DIR.lock().ok().and_then(|s| s.clone());
        let f = session_file();
        match (d, f) {
            (Some(d), Some(f)) => (d, f),
            _ => return,
        }
    };
    if std::fs::create_dir_all(&dir).is_err() {
        FILE_OK.store(false, Ordering::Relaxed);
        return;
    }
    let line = format!("[{}] [{}] {}\n", entry.time, entry.level.to_uppercase(), entry.message);
    let res = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(&file))
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
    if res.is_err() {
        // 磁盘写失败只关文件通道（权限/磁盘满），内存与 UI 不受影响，避免每条日志刷错误
        FILE_OK.store(false, Ordering::Relaxed);
    }
}

fn logs_dir() -> Option<PathBuf> {
    LOGS_DIR.lock().ok().and_then(|s| s.clone())
}

/// 「清除数据（含日志）」/「清除日志」后调用：缓冲清空，下次写入自动重建会话文件。
pub fn clear_all() {
    if let Ok(mut buf) = BUFFER.lock() {
        buf.clear();
    }
    if let Some(dir) = logs_dir() {
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    FILE_OK.store(true, Ordering::Relaxed);
}

// ── Tauri 命令（供「日志」页与错误边界使用） ────────────────────────────────

/// 当前会话日志（内存缓冲快照，UI 轮询拉取）
#[tauri::command]
pub fn log_recent() -> Vec<LogEntry> {
    match BUFFER.lock() {
        Ok(buf) => buf.iter().cloned().collect(),
        Err(_) => Vec::new(),
    }
}

/// 导出本次会话日志为文件（来源是内存缓冲：即使「自动记录」关闭过一段也有完整可见内容）
#[tauri::command]
pub fn log_export(path: String) -> Result<usize, String> {
    let buf = match BUFFER.lock() {
        Ok(buf) => buf.iter().cloned().collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    let (date, time) = now_parts();
    let mut text = format!(
        "MC汉化工坊 会话日志导出\n导出时间：{date} {time}\n条数：{}\n──────────────\n",
        buf.len()
    );
    for e in &buf {
        text.push_str(&format!("[{}] [{}] {}\n", e.time, e.level.to_uppercase(), e.message));
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    info(&format!("导出会话日志 → {path}（{} 条）", buf.len()));
    Ok(buf.len())
}

/// 用系统文件管理器打开日志目录（目录不存在则创建），返回目录路径供界面显示。
///
/// **在 Rust 侧直接调 opener 插件**，而不是把路径丢给前端调 `open_path`：
/// 前端调的是插件的 IPC 命令，要过 capabilities 的 ACL —— `opener:default` 里只有
/// `open-url` 与 `reveal-item-in-dir`，没有 `open-path`，于是表现为
/// 「Command plugin:opener|open_path not allowed by ACL」（实测踩到过）。
/// 补 `opener:allow-open-path` 是"给整个前端开放任意路径"，范围过宽；
/// 从 Rust 调不经过 IPC 边界、不受 ACL 约束，同时这个命令能打开的永远只有日志目录。
#[tauri::command]
pub fn log_open_dir() -> Result<String, String> {
    let dir = logs_dir().ok_or("日志目录不可用")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(dir.display().to_string(), None::<String>)
        .map_err(|e| format!("无法打开日志文件夹：{e}"))?;
    Ok(dir.display().to_string())
}

/// 清除全部日志文件 + 当前会话缓冲。日志器保持可用：之后的新日志继续产生。
#[tauri::command]
pub fn log_clear() -> Result<(), String> {
    clear_all();
    info("日志已清除");
    Ok(())
}

/// 界面启动时告知本地时区偏移（分钟，东八区 = 480）：日志时间戳据此换算成本地时间。
/// 顺带把「会话开始」那行补落下去（时区已知了，它才不会与后续行差一个时区）。
#[tauri::command]
pub fn log_set_tz_offset(minutes: i64) {
    // 现实世界的时区偏移不超过 ±14 小时；越界值一律忽略（宁可按 UTC，也不写出离谱的时间）
    if minutes.abs() <= 14 * 60 {
        TZ_OFFSET_MIN.store(minutes, Ordering::Relaxed);
    }
    ensure_start();
}

/// 前端事件入口（错误边界等）：同样脱敏后进入统一日志流
#[tauri::command]
pub fn log_event(level: String, message: String) {
    let level = match level.to_lowercase().as_str() {
        "warn" | "warning" => "warn",
        "error" => "error",
        _ => "info",
    };
    write(level, &message);
}
