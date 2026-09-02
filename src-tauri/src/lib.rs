mod commands;
mod core;
mod export;
mod settings;
mod translate;
#[cfg(feature = "devtools")]
mod dev;

use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // 拖入 jar：Rust 侧拿到绝对路径，转发给前端
            if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let paths: Vec<String> = paths
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                let _ = window.emit("file-dropped", paths);
            }
            // 主窗口销毁 → 退出整个应用（devtools 第二窗口一并关闭，不残留后台进程）
            if window.label() == "main" {
                if let WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::parse_jar,
            commands::run_translation,
            commands::export_resource_pack,
            commands::export_resource_pack_multi,
            commands::load_settings,
            commands::save_settings,
            commands::list_models,
            commands::test_model,
            commands::export_mod_jar,
            commands::cancel_translation,
            commands::pause_translation,
            commands::resume_translation,
            commands::parse_shader_pack,
            commands::parse_resource_pack,
            commands::detect_pack_type,
            commands::get_prompt_template,
            commands::check_update,
            commands::deep_scan_jar,
            commands::export_shader_zh,
            commands::export_resource_pack_desc,
            // devtools 专用命令：仅在 devtools feature 下注册
            #[cfg(feature = "devtools")]
            commands::devtools::dev_parse_text,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_validate_placeholders,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_preview_export,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_set_fault,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_clear_fault,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_open_devtools_window,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_read_text_file,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_encode_pairs,
            #[cfg(feature = "devtools")]
            commands::devtools::dev_write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
