mod mcp_bridge;

use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// The frontend supplies content only. A native dialog is the only way to
/// select a destination, so this command never accepts an arbitrary path.
#[tauri::command]
async fn save_backup(app: tauri::AppHandle, content: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let destination = app
            .dialog()
            .file()
            .set_title("导出回响备份")
            .set_file_name("recall-backup.json")
            .add_filter("JSON 备份", &["json"])
            .blocking_save_file();

        let Some(destination) = destination else {
            return Ok(false);
        };
        let path = destination
            .into_path()
            .map_err(|error| format!("无法使用此保存位置：{error}"))?;
        std::fs::write(path, content)
            .map_err(|error| format!("无法保存备份，请检查磁盘空间和文件权限：{error}"))?;
        Ok(true)
    })
    .await
    .map_err(|error| format!("无法打开保存对话框：{error}"))?
}

/// Markdown links may open web pages or email composers, never local files
/// or executable/custom URL schemes. The frontend cannot select an opener.
#[tauri::command]
async fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "链接地址无效".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("仅支持网页和邮件链接".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        app.opener()
            .open_url(parsed.as_str(), None::<&str>)
            .map_err(|error| format!("无法打开链接：{error}"))
    })
    .await
    .map_err(|error| format!("无法打开链接：{error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // Plugin setup runs before configured windows are created. Register
        // state here so even the first page's readiness IPC can find it.
        .plugin(
            tauri::plugin::Builder::new("recall-mcp")
                .setup(|app, _| {
                    app.manage(mcp_bridge::start(app));
                    Ok(())
                })
                .build(),
        )
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                if let Some(bridge) = webview.try_state::<Arc<mcp_bridge::Bridge>>() {
                    bridge.set_ready(false);
                }
            }
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(bridge) = window.try_state::<Arc<mcp_bridge::Bridge>>() {
                    bridge.close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_backup,
            open_external_url,
            mcp_bridge::mcp_bridge_ready,
            mcp_bridge::mcp_snapshot_response,
            mcp_bridge::mcp_connection_info,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Recall")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(bridge) = app.try_state::<Arc<mcp_bridge::Bridge>>() {
                    bridge.close();
                }
            }
        });
}
