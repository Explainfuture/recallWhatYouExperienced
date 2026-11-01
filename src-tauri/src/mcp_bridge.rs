//! Authenticated, read-only transport between a local MCP process and the main
//! webview. Notes stay in IndexedDB: every snapshot is requested from the live
//! frontend, and this module never keeps a second copy on disk.

use std::{
    collections::HashMap,
    fs,
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};

use axum::{
    extract::State as HttpState,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tauri::{path::BaseDirectory, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{oneshot, watch, Semaphore};
use uuid::Uuid;

const BRIDGE_VERSION: u8 = 1;
const MAX_PENDING: usize = 8;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);

type Dispatcher = Arc<dyn Fn(SnapshotRequest) -> Result<(), String> + Send + Sync>;
type SnapshotReply = Result<String, SnapshotFailure>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequest {
    request_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Descriptor<'a> {
    bridge_version: u8,
    pid: u32,
    base_url: &'a str,
    token: &'a str,
    app_version: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    bridge_version: u8,
    app_version: String,
    base_url: Option<String>,
    descriptor_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_path: Option<String>,
    ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct BridgeConfig {
    app_version: String,
    token: String,
    host: String,
    descriptor_path: Option<PathBuf>,
    server_path: Option<PathBuf>,
    resource_error: Option<String>,
    timeout: Duration,
}

pub struct Bridge {
    config: BridgeConfig,
    available: AtomicBool,
    ready: AtomicBool,
    closed: AtomicBool,
    transport_error: Mutex<Option<String>>,
    pending: Mutex<HashMap<String, oneshot::Sender<SnapshotReply>>>,
    slots: Arc<Semaphore>,
    dispatch: Dispatcher,
    shutdown: watch::Sender<bool>,
}

#[derive(Debug)]
enum SnapshotFailure {
    NotReady,
    Frontend,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Bridge {
    fn new(config: BridgeConfig, dispatch: Dispatcher) -> Self {
        let (shutdown, _) = watch::channel(false);
        Self {
            config,
            available: AtomicBool::new(false),
            ready: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            transport_error: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAX_PENDING)),
            dispatch,
            shutdown,
        }
    }

    fn is_ready(&self) -> bool {
        self.available.load(Ordering::Acquire)
            && self.ready.load(Ordering::Acquire)
            && !self.closed.load(Ordering::Acquire)
    }

    pub fn set_ready(&self, ready: bool) {
        let ready = ready
            && self.available.load(Ordering::Acquire)
            && !self.closed.load(Ordering::Acquire);
        self.ready.store(ready, Ordering::Release);
        if !ready {
            // Store false before taking the lock: a request either observes
            // false, or is already registered and is cancelled by this drain.
            for (_, sender) in lock(&self.pending).drain() {
                let _ = sender.send(Err(SnapshotFailure::NotReady));
            }
        }
    }

    fn info(&self) -> ConnectionInfo {
        ConnectionInfo {
            bridge_version: BRIDGE_VERSION,
            app_version: self.config.app_version.clone(),
            base_url: self
                .available
                .load(Ordering::Acquire)
                .then(|| format!("http://{}", self.config.host)),
            descriptor_path: self
                .config
                .descriptor_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            server_path: self
                .config
                .server_path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            ready: self.is_ready(),
            error: lock(&self.transport_error)
                .clone()
                .or_else(|| self.config.resource_error.clone()),
        }
    }

    fn respond(
        &self,
        request_id: &str,
        content: Option<String>,
        error: Option<String>,
    ) -> Result<(), String> {
        let result = match (content, error) {
            (Some(content), None) => Ok(content),
            (None, Some(_)) => Err(SnapshotFailure::Frontend),
            _ => return Err("读取回复必须包含 content 或 error，且不能同时包含两者".into()),
        };
        let sender = lock(&self.pending)
            .remove(request_id)
            .ok_or_else(|| "MCP 读取请求已结束或不存在".to_string())?;
        sender
            .send(result)
            .map_err(|_| "MCP 读取请求已结束".to_string())
    }

    fn fail_transport(&self, error: String) {
        *lock(&self.transport_error) = Some(error);
        self.available.store(false, Ordering::Release);
        self.set_ready(false);
        self.cleanup_descriptor();
    }

    pub fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.available.store(false, Ordering::Release);
        self.set_ready(false);
        self.shutdown.send_replace(true);
        self.cleanup_descriptor();
    }

    fn cleanup_descriptor(&self) {
        if let Some(path) = &self.config.descriptor_path {
            remove_owned_descriptor(path, &self.config.token, std::process::id());
        }
    }
}

/// A disconnected HTTP client also releases its pending entry and permit.
struct PendingRequest {
    bridge: Arc<Bridge>,
    request_id: String,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        lock(&self.bridge.pending).remove(&self.request_id);
    }
}

fn response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn problem(status: StatusCode, code: &str, message: &str) -> Response {
    response(status, json!({ "error": { "code": code, "message": message } }))
}

fn authenticate(bridge: &Bridge, headers: &HeaderMap, uri: &Uri) -> Result<(), Response> {
    if headers.contains_key(header::ORIGIN) {
        return Err(problem(
            StatusCode::FORBIDDEN,
            "origin_rejected",
            "Browser origins cannot access this local bridge.",
        ));
    }
    let hosts: Vec<_> = headers.get_all(header::HOST).iter().collect();
    if hosts.len() != 1
        || hosts[0].to_str().ok() != Some(bridge.config.host.as_str())
        || uri
            .authority()
            .is_some_and(|authority| authority.as_str() != bridge.config.host)
    {
        return Err(problem(
            StatusCode::FORBIDDEN,
            "host_rejected",
            "The Host must match the bridge's 127.0.0.1 address.",
        ));
    }
    let authorizations: Vec<_> = headers.get_all(header::AUTHORIZATION).iter().collect();
    let valid = authorizations.len() == 1
        && authorizations[0]
            .to_str()
            .ok()
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| {
                bool::from(token.as_bytes().ct_eq(bridge.config.token.as_bytes()))
            });
    if !valid {
        return Err(problem(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid local bridge token is required.",
        ));
    }
    Ok(())
}

fn router(bridge: Arc<Bridge>) -> Router {
    // One fallback handler applies authentication even to unknown paths and
    // unsupported methods; there are no unauthenticated discovery routes.
    Router::new().fallback(handle_request).with_state(bridge)
}

async fn handle_request(
    HttpState(bridge): HttpState<Arc<Bridge>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authenticate(&bridge, &headers, &uri) {
        return response;
    }
    if method != Method::GET {
        let mut response = problem(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "Only GET requests are supported.",
        );
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET"));
        return response;
    }
    match uri.path() {
        "/health" => response(
            StatusCode::OK,
            json!({
                "bridgeVersion": BRIDGE_VERSION,
                "appVersion": bridge.config.app_version,
                "ready": bridge.is_ready(),
            }),
        ),
        "/snapshot" => snapshot(bridge).await,
        _ => problem(StatusCode::NOT_FOUND, "not_found", "Unknown bridge route."),
    }
}

fn not_ready() -> Response {
    problem(
        StatusCode::SERVICE_UNAVAILABLE,
        "bridge_not_ready",
        "Open Recall and wait for its local records to finish loading.",
    )
}

async fn snapshot(bridge: Arc<Bridge>) -> Response {
    if !bridge.is_ready() {
        return not_ready();
    }
    let Ok(_permit) = bridge.slots.clone().try_acquire_owned() else {
        return problem(
            StatusCode::SERVICE_UNAVAILABLE,
            "bridge_busy",
            "Too many reads are in progress; retry shortly.",
        );
    };
    let request_id = Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut pending = lock(&bridge.pending);
        if !bridge.is_ready() {
            return not_ready();
        }
        pending.insert(request_id.clone(), sender);
    }
    let _request = PendingRequest {
        bridge: bridge.clone(),
        request_id: request_id.clone(),
    };
    if (bridge.dispatch)(SnapshotRequest { request_id }).is_err() {
        bridge.set_ready(false);
        return not_ready();
    }
    let content = match tokio::time::timeout(bridge.config.timeout, receiver).await {
        Err(_) => {
            return problem(
                StatusCode::GATEWAY_TIMEOUT,
                "snapshot_timeout",
                "The Recall window did not answer within five seconds.",
            );
        }
        Ok(Err(_)) | Ok(Ok(Err(SnapshotFailure::NotReady))) => return not_ready(),
        Ok(Ok(Err(SnapshotFailure::Frontend))) => {
            return problem(
                StatusCode::INTERNAL_SERVER_ERROR,
                "snapshot_failed",
                "The Recall window could not read its saved records.",
            );
        }
        Ok(Ok(Ok(content))) => content,
    };
    match snapshot_envelope(&content, &bridge.config.app_version) {
        Ok(body) => response(StatusCode::OK, body),
        Err(message) => problem(StatusCode::BAD_GATEWAY, "snapshot_invalid", &message),
    }
}

fn snapshot_envelope(content: &str, app_version: &str) -> Result<Value, String> {
    let data: Value = serde_json::from_str(content)
        .map_err(|_| "The Recall window returned invalid JSON.".to_string())?;
    let version = data.get("version").and_then(Value::as_u64);
    if !matches!(version, Some(1 | 2))
        || !data.get("sessions").is_some_and(Value::is_array)
        || (version == Some(2) && !data.get("folders").is_some_and(Value::is_array))
    {
        return Err("The Recall window returned an unsupported backup format.".into());
    }
    let captured_at = data
        .get("exportedAt")
        .and_then(Value::as_str)
        .filter(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).is_ok())
        .ok_or_else(|| "The snapshot has no valid exportedAt timestamp.".to_string())?
        .to_string();
    Ok(json!({
        "bridgeVersion": BRIDGE_VERSION,
        "appVersion": app_version,
        "capturedAt": captured_at,
        "data": data,
    }))
}

fn write_descriptor(path: &Path, descriptor: &Descriptor<'_>) -> Result<(), String> {
    let parent = path.parent().ok_or("MCP 连接文件路径无效")?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 MCP 目录：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法设置 MCP 目录权限：{error}"))?;
    }
    let _guard = descriptor_lock(parent)
        .map_err(|_| "另一实例正在更新 MCP 连接文件，请重启此窗口后重试".to_string())?;
    // tempfile creates a private, exclusive file. On Windows it inherits the
    // current user's LocalAppData ACL; Unix permissions are explicitly 0600.
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("无法创建 MCP 连接文件：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法设置 MCP 连接文件权限：{error}"))?;
    }
    serde_json::to_writer(&mut temporary, descriptor)
        .map_err(|error| format!("无法写入 MCP 连接文件：{error}"))?;
    temporary
        .flush()
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("无法保存 MCP 连接文件：{error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("无法替换 MCP 连接文件：{error}"))?;
    Ok(())
}

fn remove_owned_descriptor(path: &Path, token: &str, pid: u32) {
    let Some(parent) = path.parent() else { return };
    let Ok(_guard) = descriptor_lock(parent) else { return };
    let owned = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|descriptor| {
            descriptor.get("token").and_then(Value::as_str) == Some(token)
                && descriptor.get("pid").and_then(Value::as_u64) == Some(u64::from(pid))
        });
    if owned {
        let _ = fs::remove_file(path);
    }
}

fn descriptor_lock(parent: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(parent.join("bridge.lock"))?;
    // Serialize replacement with ownership-check-and-removal across instances.
    // A busy lock is nonblocking so it can never stall application startup/exit.
    fs2::FileExt::try_lock_exclusive(&file)?;
    Ok(file)
}

fn validate_server_resource(
    resource: Result<PathBuf, String>,
) -> (Option<PathBuf>, Option<String>) {
    match resource {
        Ok(path)
            if path.is_file()
                && path
                    .parent()
                    .is_some_and(|parent| parent.join("AGENTS.md").is_file()) =>
        {
            (Some(path), None)
        }
        Ok(_) => (
            None,
            Some("MCP 服务文件或使用指南缺失，请重新安装完整的 Recall 应用".into()),
        ),
        Err(error) => (None, Some(error)),
    }
}

/// Failure to create the bridge must never prevent the notebook from opening.
pub fn start(app: &tauri::AppHandle) -> Arc<Bridge> {
    let app_version = app.package_info().version.to_string();
    let descriptor = app
        .path()
        .app_local_data_dir()
        .map(|path| path.join("mcp").join("bridge.json"))
        .map_err(|error| format!("无法定位 MCP 本地目录：{error}"));
    let resource = app
        .path()
        .resolve("mcp/server.mjs", BaseDirectory::Resource)
        .map_err(|error| format!("无法定位 MCP 服务文件：{error}"));
    let (server_path, resource_error) = validate_server_resource(resource);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).and_then(|listener| {
        listener.set_nonblocking(true)?;
        Ok(listener)
    });
    let address = listener.as_ref().ok().and_then(|listener| listener.local_addr().ok());
    let host = address.map(|address| address.to_string()).unwrap_or_default();
    let event_app = app.clone();
    let bridge = Arc::new(Bridge::new(
        BridgeConfig {
            app_version,
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            host,
            descriptor_path: descriptor.as_ref().ok().cloned(),
            server_path,
            resource_error,
            timeout: SNAPSHOT_TIMEOUT,
        },
        Arc::new(move |request| {
            event_app
                .emit_to(
                    tauri::EventTarget::WebviewWindow { label: "main".into() },
                    "recall:mcp-read",
                    request,
                )
                .map_err(|error| error.to_string())
        }),
    ));
    let listener = match listener {
        Ok(listener) if address.is_some() => listener,
        Ok(_) => {
            bridge.fail_transport("无法获取 MCP 本地监听地址".into());
            return bridge;
        }
        Err(error) => {
            bridge.fail_transport(format!("无法启动 MCP 本地监听：{error}"));
            return bridge;
        }
    };
    let descriptor_path = match descriptor {
        Ok(path) => path,
        Err(error) => {
            bridge.fail_transport(error);
            return bridge;
        }
    };
    let base_url = format!("http://{}", bridge.config.host);
    if let Err(error) = write_descriptor(
        &descriptor_path,
        &Descriptor {
            bridge_version: BRIDGE_VERSION,
            pid: std::process::id(),
            base_url: &base_url,
            token: &bridge.config.token,
            app_version: &bridge.config.app_version,
        },
    ) {
        bridge.fail_transport(error);
        return bridge;
    }
    bridge.available.store(true, Ordering::Release);
    let server = bridge.clone();
    let mut shutdown = bridge.shutdown.subscribe();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                server.fail_transport(format!("无法启动 MCP 本地服务：{error}"));
                return;
            }
        };
        let result = axum::serve(listener, router(server.clone()))
            .with_graceful_shutdown(async move {
                if !*shutdown.borrow() {
                    let _ = shutdown.changed().await;
                }
            })
            .await;
        if let Err(error) = result {
            server.fail_transport(format!("MCP 本地服务已停止：{error}"));
        }
    });
    bridge
}

fn ensure_main(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("MCP 桥接命令仅允许主窗口调用".into())
    }
}

#[tauri::command]
pub fn mcp_bridge_ready(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
    ready: bool,
) -> Result<(), String> {
    ensure_main(window.label())?;
    bridge.set_ready(ready);
    Ok(())
}

#[tauri::command]
pub fn mcp_snapshot_response(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
    request_id: String,
    content: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    ensure_main(window.label())?;
    bridge.respond(&request_id, content, error)
}

#[tauri::command]
pub fn mcp_connection_info(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<ConnectionInfo, String> {
    ensure_main(window.label())?;
    Ok(bridge.info())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::{to_bytes, Body}, http::Request};
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
    use tower::ServiceExt;

    const TEST_HOST: &str = "127.0.0.1:45678";
    const TEST_TOKEN: &str = "private-fixture-token";

    fn harness(ready: bool, timeout: Duration) -> (Arc<Bridge>, UnboundedReceiver<String>) {
        let (sender, receiver) = unbounded_channel();
        let bridge = Arc::new(Bridge::new(
            BridgeConfig {
                app_version: "0.4.0-test".into(),
                token: TEST_TOKEN.into(),
                host: TEST_HOST.into(),
                descriptor_path: None,
                server_path: None,
                resource_error: None,
                timeout,
            },
            Arc::new(move |event| sender.send(event.request_id).map_err(|_| "closed".into())),
        ));
        bridge.available.store(true, Ordering::Release);
        bridge.set_ready(ready);
        (bridge, receiver)
    }

    fn request(path: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header(header::HOST, TEST_HOST)
            .header(header::AUTHORIZATION, format!("Bearer {TEST_TOKEN}"))
            .body(Body::empty())
            .unwrap()
    }

    async fn body(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn start_read(bridge: &Arc<Bridge>) -> tokio::task::JoinHandle<Response> {
        let app = router(bridge.clone());
        tokio::spawn(async move { app.oneshot(request("/snapshot")).await.unwrap() })
    }

    async fn next_id(receiver: &mut UnboundedReceiver<String>) -> String {
        tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .unwrap()
            .unwrap()
    }

    fn backup(title: &str) -> String {
        json!({
            "version": 2,
            "exportedAt": "2026-11-02T00:00:00.000Z",
            "sessions": [{"id": "fixture-session", "title": title}],
            "folders": [],
        }).to_string()
    }

    #[tokio::test]
    async fn every_route_requires_authorization_and_disables_caching() {
        let (bridge, _) = harness(true, SNAPSHOT_TIMEOUT);
        for path in ["/health", "/snapshot", "/unknown"] {
            let mut input = request(path);
            input.headers_mut().remove(header::AUTHORIZATION);
            let response = router(bridge.clone()).oneshot(input).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()[header::PRAGMA], "no-cache");
        }
        let mut input = request("/health");
        input.headers_mut().insert(header::AUTHORIZATION, HeaderValue::from_static("Bearer wrong"));
        assert_eq!(router(bridge).oneshot(input).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_browser_origins_foreign_hosts_and_duplicate_credentials() {
        let (bridge, _) = harness(true, SNAPSHOT_TIMEOUT);
        for origin in ["https://example.test", "null", ""] {
            let mut input = request("/health");
            input.headers_mut().insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            assert_eq!(router(bridge.clone()).oneshot(input).await.unwrap().status(), StatusCode::FORBIDDEN);
        }
        for host in ["localhost:45678", "127.0.0.2:45678", "127.0.0.1:80", "example.test:45678"] {
            let mut input = request("/health");
            input.headers_mut().insert(header::HOST, HeaderValue::from_str(host).unwrap());
            assert_eq!(router(bridge.clone()).oneshot(input).await.unwrap().status(), StatusCode::FORBIDDEN);
        }
        let mut duplicate_host = request("/health");
        duplicate_host.headers_mut().append(header::HOST, HeaderValue::from_static(TEST_HOST));
        assert_eq!(router(bridge.clone()).oneshot(duplicate_host).await.unwrap().status(), StatusCode::FORBIDDEN);
        let mut duplicate_auth = request("/health");
        duplicate_auth.headers_mut().append(header::AUTHORIZATION, HeaderValue::from_static("Bearer wrong"));
        assert_eq!(router(bridge.clone()).oneshot(duplicate_auth).await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let absolute = request("http://example.test/health");
        assert_eq!(router(bridge).oneshot(absolute).await.unwrap().status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn exposes_only_get_health_and_snapshot() {
        let (bridge, _) = harness(false, SNAPSHOT_TIMEOUT);
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::HEAD, Method::OPTIONS] {
            let mut input = request("/health");
            *input.method_mut() = method;
            let response = router(bridge.clone()).oneshot(input).await.unwrap();
            assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
            assert_eq!(response.headers()[header::ALLOW], "GET");
        }
        assert_eq!(router(bridge.clone()).oneshot(request("/unknown")).await.unwrap().status(), StatusCode::NOT_FOUND);
        let response = router(bridge.clone()).oneshot(request("/health")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await, json!({"bridgeVersion": 1, "appVersion": "0.4.0-test", "ready": false}));
        assert_eq!(router(bridge).oneshot(request("/snapshot")).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn each_snapshot_requests_fresh_frontend_data() {
        let (bridge, mut reads) = harness(true, SNAPSHOT_TIMEOUT);
        let mut ids = Vec::new();
        for title in ["first committed value", "changed committed value"] {
            let response = start_read(&bridge);
            let id = next_id(&mut reads).await;
            bridge.respond(&id, Some(backup(title)), None).unwrap();
            ids.push(id);
            let response = response.await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let result = body(response).await;
            assert_eq!(result["bridgeVersion"], 1);
            assert_eq!(result["capturedAt"], result["data"]["exportedAt"]);
            assert_eq!(result["data"]["sessions"][0]["title"], title);
        }
        assert_ne!(ids[0], ids[1]);
        assert!(lock(&bridge.pending).is_empty());
        assert_eq!(bridge.slots.available_permits(), MAX_PENDING);
    }

    #[tokio::test]
    async fn caps_in_flight_reads_at_eight_and_recovers_capacity() {
        let (bridge, mut reads) = harness(true, SNAPSHOT_TIMEOUT);
        let mut tasks = Vec::new();
        let mut ids = Vec::new();
        for _ in 0..MAX_PENDING {
            tasks.push(start_read(&bridge));
            ids.push(next_id(&mut reads).await);
        }
        let response = router(bridge.clone()).oneshot(request("/snapshot")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body(response).await["error"]["code"], "bridge_busy");
        for id in ids {
            bridge.respond(&id, Some(backup("fixture")), None).unwrap();
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().status(), StatusCode::OK);
        }
        assert_eq!(bridge.slots.available_permits(), MAX_PENDING);
        assert!(lock(&bridge.pending).is_empty());
    }

    #[tokio::test]
    async fn timeout_removes_pending_entry_and_rejects_late_replies() {
        let (bridge, mut reads) = harness(true, Duration::from_millis(20));
        let response = start_read(&bridge);
        let id = next_id(&mut reads).await;
        let response = response.await.unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(body(response).await["error"]["code"], "snapshot_timeout");
        assert!(lock(&bridge.pending).is_empty());
        assert_eq!(bridge.slots.available_permits(), MAX_PENDING);
        assert!(bridge.respond(&id, Some(backup("late")), None).is_err());
    }

    #[tokio::test]
    async fn cancelling_client_or_frontend_releases_waiters() {
        let (bridge, mut reads) = harness(true, SNAPSHOT_TIMEOUT);
        let abandoned = start_read(&bridge);
        next_id(&mut reads).await;
        abandoned.abort();
        assert!(abandoned.await.unwrap_err().is_cancelled());
        assert!(lock(&bridge.pending).is_empty());
        assert_eq!(bridge.slots.available_permits(), MAX_PENDING);

        let pending = start_read(&bridge);
        next_id(&mut reads).await;
        bridge.set_ready(false);
        assert_eq!(pending.await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(lock(&bridge.pending).is_empty());
        bridge.set_ready(true);
        assert!(bridge.is_ready());
        bridge.close();
        bridge.set_ready(true);
        assert!(!bridge.is_ready());
    }

    #[tokio::test]
    async fn frontend_errors_and_invalid_json_are_not_cached_or_leaked() {
        let (bridge, mut reads) = harness(true, SNAPSHOT_TIMEOUT);
        let failed = start_read(&bridge);
        let id = next_id(&mut reads).await;
        bridge.respond(&id, None, Some("private underlying exception".into())).unwrap();
        let response = failed.await.unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!body(response).await.to_string().contains("private underlying exception"));

        let invalid = start_read(&bridge);
        let id = next_id(&mut reads).await;
        bridge.respond(&id, Some("not json".into()), None).unwrap();
        assert_eq!(invalid.await.unwrap().status(), StatusCode::BAD_GATEWAY);
        assert!(bridge.respond("not-an-active-request", Some(backup("fake")), None).is_err());
    }

    #[test]
    fn validates_backup_shape_and_timestamp_without_changing_content() {
        for content in ["null", "{}", r#"{"version":2,"sessions":[],"folders":[],"exportedAt":"yesterday"}"#] {
            assert!(snapshot_envelope(content, "test").is_err());
        }
        let legacy = json!({"version":1,"sessions":[],"exportedAt":"2026-11-02T08:00:00+08:00"});
        assert_eq!(snapshot_envelope(&legacy.to_string(), "test").unwrap()["data"], legacy);
        let current: Value = serde_json::from_str(&backup("# Markdown\n\n正文与 **格式**")).unwrap();
        assert_eq!(snapshot_envelope(&current.to_string(), "test").unwrap()["data"], current);
    }

    #[test]
    fn command_authorization_and_connection_info_do_not_expose_token() {
        assert!(ensure_main("main").is_ok());
        for label in ["", "settings", "main-copy"] {
            assert!(ensure_main(label).is_err());
        }
        let (bridge, _) = harness(true, SNAPSHOT_TIMEOUT);
        let info = serde_json::to_value(bridge.info()).unwrap();
        assert!(info.get("token").is_none());
        assert!(!info.to_string().contains(TEST_TOKEN));
        bridge.fail_transport("fixture startup failure".into());
        bridge.set_ready(true);
        let info = serde_json::to_value(bridge.info()).unwrap();
        assert_eq!(info["ready"], false);
        assert_eq!(info["baseUrl"], Value::Null);
        assert_eq!(info["error"], "fixture startup failure");
    }

    #[test]
    fn missing_resources_are_not_advertised_as_a_usable_server_path() {
        let directory = tempfile::tempdir().unwrap();
        let server = directory.path().join("server.mjs");
        let (mut bridge, _) = harness(true, SNAPSHOT_TIMEOUT);
        for create_server in [false, true] {
            if create_server {
                fs::write(&server, "// fixture").unwrap();
            }
            let (path, error) = validate_server_resource(Ok(server.clone()));
            let state = Arc::get_mut(&mut bridge).unwrap();
            state.config.server_path = path;
            state.config.resource_error = error;
            let info = serde_json::to_value(bridge.info()).unwrap();
            assert!(info.get("serverPath").is_none());
            assert!(info["error"].is_string());
            // Transport readiness remains independent of bundled Node resources.
            assert_eq!(info["ready"], true);
        }
        fs::write(directory.path().join("AGENTS.md"), "# Fixture guide").unwrap();
        let (path, error) = validate_server_resource(Ok(server.clone()));
        assert_eq!(path, Some(server));
        assert_eq!(error, None);
    }

    #[test]
    fn descriptor_replacement_and_cleanup_preserve_newer_instances() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("mcp").join("bridge.json");
        let first = Descriptor { bridge_version: 1, pid: 123, base_url: "http://127.0.0.1:1234", token: "old", app_version: "test" };
        let second = Descriptor { bridge_version: 1, pid: 456, base_url: "http://127.0.0.1:5678", token: "new", app_version: "test" };
        write_descriptor(&path, &first).unwrap();
        write_descriptor(&path, &second).unwrap();
        remove_owned_descriptor(&path, "old", 123);
        let current: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(current["token"], "new");
        remove_owned_descriptor(&path, "new", 123);
        assert!(path.exists());
        remove_owned_descriptor(&path, "new", 456);
        assert!(!path.exists());
    }

    #[test]
    fn busy_descriptor_lock_never_blocks_startup_or_deletes_another_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bridge.json");
        let descriptor = Descriptor { bridge_version: 1, pid: 123, base_url: "http://127.0.0.1:1234", token: "fixture", app_version: "test" };
        write_descriptor(&path, &descriptor).unwrap();
        let guard = descriptor_lock(directory.path()).unwrap();
        assert!(write_descriptor(&path, &descriptor).is_err());
        remove_owned_descriptor(&path, "fixture", 123);
        assert!(path.exists());
        drop(guard);
        remove_owned_descriptor(&path, "fixture", 123);
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_is_private_to_the_current_user() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("mcp");
        let path = parent.join("bridge.json");
        let descriptor = Descriptor { bridge_version: 1, pid: 123, base_url: "http://127.0.0.1:1234", token: "fixture", app_version: "test" };
        write_descriptor(&path, &descriptor).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&parent).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
