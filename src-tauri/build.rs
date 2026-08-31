fn main() {
    tauri_build::build()
}
// 2026-08-31 强制重嵌入 dist（前端 i18n 改造后，cargo 缓存未自动重跑 build script）
