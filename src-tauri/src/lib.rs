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
        .setup(|app| {
            // 关闭行为：启动时从设置文件刷新
            let settings = crate::settings::Settings::load(&commands::settings_path(app.handle()));
            crate::settings::set_close_behavior(&settings);

            // 托盘：左键点击恢复窗口；菜单提供 显示/退出
            use tauri::{
                menu::{Menu, MenuItem},
                tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
                Manager,
            };
            let lang_en = settings.language == "en";
            let show_label = if lang_en { "Show window" } else { "显示主窗口" };
            let quit_label = if lang_en { "Exit" } else { "退出" };
            let show = MenuItem::with_id(app, "tray-show", show_label, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "tray-quit", quit_label, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("MC 汉化工坊")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "tray-show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
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
                // 关闭行为 = 最小化到托盘：拦截关闭请求，仅隐藏窗口
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if crate::settings::close_minimize_enabled() {
                        api.prevent_close();
                        let _ = window.hide();
                    }
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
            commands::save_session_cache,
            commands::load_session_cache,
            commands::clear_session_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
