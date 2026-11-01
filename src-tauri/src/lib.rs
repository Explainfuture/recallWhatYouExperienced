use tauri_plugin_dialog::DialogExt;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_backup])
        .run(tauri::generate_context!())
        .expect("failed to start Recall");
}

