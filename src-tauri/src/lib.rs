mod commands;
mod core;
mod export;
mod settings;
mod translate;

use tauri::{Emitter, WindowEvent};

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
        })
        .invoke_handler(tauri::generate_handler![
            commands::parse_jar,
            commands::run_translation,
            commands::export_resource_pack,
            commands::load_settings,
            commands::save_settings,
            commands::list_models,
            commands::export_mod_jar,
            commands::cancel_translation,
            commands::pause_translation,
            commands::resume_translation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
