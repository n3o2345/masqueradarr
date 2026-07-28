//! TSH: tuner sharing for HDHomeRun sources. When N clients are watching the SAME channel (same device +
//! channel = same stream entry URL), only the FIRST one actually opens a connection to the tuner; every
//! later client attaches to that live upstream instead of opening its own. An HDHomeRun device has a hard
//! TunerCount cap (server/src/models/Playlist.ts `deviceTunerCount`, from discover.json) and one open
//! connection consumes one tuner regardless of how many people are actually watching it — without sharing,
//! two viewers on the same channel silently burn two tuners for identical bytes.
//!
//! Scope: HDHomeRun only (the caller in proxy.rs gates by `source == "hdhomerun"`). That adapter is a pure
//! raw-MPEG-TS passthrough (adapters/hdhomerun/index.ts — no manifest, no hop, no failover), so "the stream"
//! really is just bytes-in/bytes-out and sharing the raw upstream connection is exactly sharing the content.
//!
//! Shape: one background pump per live channel drains the upstream `reqwest::Response` into a
//! `tokio::sync::broadcast` channel; each attached viewer gets its own `Receiver` turned into an axum Body.
//! The pump keeps the tuner open until IDLE_TIMEOUT after the LAST viewer detaches (see `idle_timeout()`),
//! then closes the upstream connection and removes the map entry — freeing the tuner for a different channel
//! and letting the next viewer of THIS channel open a fresh connection.

use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use bytes::Bytes;
use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, Mutex};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::log;
use crate::stream::TelemetryCtx;

/// How long a shared tuner's upstream connection stays open with ZERO attached viewers before the pump
/// gives up and releases it. Long enough that a quick channel-surf back (or an app reconnect) reuses the
/// live tuner instead of paying a fresh HDHomeRun tune-in; short enough that a genuinely abandoned channel
/// frees its tuner for other channels promptly. Overridable per-deployment for a very tight tuner budget.
fn idle_timeout() -> Duration {
    Duration::from_secs(
        std::env::var("MASQ_TUNER_IDLE_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(20),
    )
}

// Depth of the broadcast channel's ring buffer (in chunks). A viewer who falls this far behind the fastest
// consumer misses a `Lagged` gap (handled below) rather than blocking everyone else — generous enough that
// an ordinary brief stall doesn't cost a gap, since MPEG-TS chunks are small.
const BROADCAST_CAPACITY: usize = 256;

/// The key identifying one shareable upstream: (mount source, stream entry url) — same shape as the
/// resolve target cache's key (state.rs `target_key`), just local to this module.
pub fn share_key(source: &str, entry: &str) -> String {
    format!("{source}\u{0}{entry}")
}

/// One broadcast chunk: either upstream bytes, or a terminal error string (mirrors `stream::pump`'s
/// io::Error-on-stall/error behavior so every viewer's Body ends the same way theirs would have standalone).
#[derive(Clone)]
enum Chunk {
    Data(Bytes),
    Err(String),
}

struct Live {
    tx: broadcast::Sender<Chunk>,
    /// Count of currently-attached viewer Bodies (incremented on attach, decremented when a viewer's Body is
    /// dropped — see `ViewerGuard`). The pump watches this to know when to start its idle countdown.
    viewers: Arc<AtomicUsize>,
    /// The content-type the FIRST viewer's fetch actually observed from the device — replayed verbatim to
    /// every later viewer who joins without fetching (they never see the upstream response themselves).
    content_type: String,
}

pub struct TunerShare {
    live: Mutex<HashMap<String, Live>>,
}

impl TunerShare {
    pub fn new() -> Self {
        Self { live: Mutex::new(HashMap::new()) }
    }

    /// Fast path for a fresh request: if `key`'s channel already has a live shared upstream, attach as
    /// another viewer and return its Response right away — no upstream fetch happens, so no new tuner is
    /// opened. `None` means there's no live upstream for this channel right now; the caller should proceed
    /// with its own normal fetch and then call `start()`.
    pub async fn join(&self, key: &str, ctx: TelemetryCtx) -> Option<Response> {
        let mut live = self.live.lock().await;
        let entry = live.get_mut(key)?;
        entry.viewers.fetch_add(1, Ordering::SeqCst);
        let rx = entry.tx.subscribe();
        let viewers = entry.viewers.clone();
        let ct = entry.content_type.clone();
        drop(live);
        log::info("tuner", &ctx.rid, || format!("reusing live tuner for {} — no new tuner opened", ctx.entry));
        Some(viewer_response(rx, viewers, ct, ctx))
    }

    /// Register a just-fetched upstream `resp` as the shared source for `key`, and return the CALLER's own
    /// attached Response. If another request won a cold-start race in the meantime (only possible between
    /// two near-simultaneous FIRST viewers of a channel that had no live upstream a moment ago), `resp` is
    /// dropped here — closing that now-redundant tuner connection immediately — and the caller joins the
    /// winner's upstream instead, so exactly one upstream ever survives per channel.
    pub async fn start(
        self: Arc<Self>,
        key: String,
        resp: reqwest::Response,
        content_type: String,
        ctx: TelemetryCtx,
    ) -> Response {
        let mut live = self.live.lock().await;
        if let Some(existing) = live.get_mut(&key) {
            existing.viewers.fetch_add(1, Ordering::SeqCst);
            let rx = existing.tx.subscribe();
            let viewers = existing.viewers.clone();
            let ct = existing.content_type.clone();
            drop(live);
            log::info("tuner", &ctx.rid, || format!("lost the race for {} — joining the live tuner instead", ctx.entry));
            drop(resp); // closes the redundant connection this request just opened
            return viewer_response(rx, viewers, ct, ctx);
        }
        let (tx, rx) = broadcast::channel(BROADCAST_CAPACITY);
        let viewers = Arc::new(AtomicUsize::new(1));
        live.insert(
            key.clone(),
            Live { tx: tx.clone(), viewers: viewers.clone(), content_type: content_type.clone() },
        );
        drop(live);
        log::info("tuner", &ctx.rid, || format!("opened new shared tuner upstream for {}", ctx.entry));
        tokio::spawn(pump(self.clone(), key, resp, tx, viewers.clone()));
        viewer_response(rx, viewers, content_type, ctx)
    }
}

/// Drain the upstream into the broadcast channel until EOF/error, or until no viewer has been attached for
/// `idle_timeout()` (checked once a second so a quiet-of-viewers channel is still torn down promptly even
/// between data chunks). Removing the map entry on exit is what lets the NEXT viewer of this channel open a
/// fresh tuner connection — the entire point of the idle timer.
async fn pump(
    share: Arc<TunerShare>,
    key: String,
    resp: reqwest::Response,
    tx: broadcast::Sender<Chunk>,
    viewers: Arc<AtomicUsize>,
) {
    let mut stream = Box::pin(resp.bytes_stream());
    let mut zero_since: Option<Instant> = None;
    let idle = idle_timeout();
    loop {
        let tick = tokio::time::sleep(Duration::from_secs(1));
        tokio::select! {
            next = stream.next() => match next {
                Some(Ok(chunk)) => {
                    let _ = tx.send(Chunk::Data(chunk)); // Err = zero receivers right now; nothing to do
                }
                Some(Err(e)) => {
                    log::warn("tuner", "", || format!("{key}: upstream error — releasing tuner ({e})"));
                    let _ = tx.send(Chunk::Err(e.to_string()));
                    break;
                }
                None => {
                    log::info("tuner", "", || format!("{key}: upstream EOF — releasing tuner"));
                    break;
                }
            },
            _ = tick => {}
        }
        if viewers.load(Ordering::SeqCst) == 0 {
            let since = *zero_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= idle {
                log::info("tuner", "", || format!("{key}: idle {}s with no viewers — releasing tuner", idle.as_secs()));
                break;
            }
        } else {
            zero_since = None;
        }
    }
    // `resp`/`stream` are dropped here with the function, which closes the upstream TCP connection — the
    // actual tuner release. Removing the map entry is what lets a subsequent request re-tune fresh.
    share.live.lock().await.remove(&key);
}

/// Decrements the live viewer count when a viewer's Body is dropped (client disconnect, or the pump itself
/// ending the stream), flushes any residual byte count, and tells Node this socket session ended. This is
/// the ONLY place the viewer count goes down, so the pump's idle countdown always reflects reality.
struct ViewerGuard {
    viewers: Arc<AtomicUsize>,
    state: crate::state::AppState,
    stream_id: String,
    bytes: Arc<AtomicU64>,
}

impl Drop for ViewerGuard {
    fn drop(&mut self) {
        self.viewers.fetch_sub(1, Ordering::SeqCst);
        let residual = self.bytes.swap(0, Ordering::Relaxed);
        if residual > 0 {
            self.state.report(serde_json::json!({ "kind": "sbytes", "streamId": self.stream_id, "bytes": residual }));
        }
        log::info("tuner", "", || format!("viewer session close ({})", self.stream_id));
        self.state.report(serde_json::json!({ "kind": "close", "streamId": self.stream_id }));
    }
}

/// Build one viewer's axum Response: a Body over its own broadcast Receiver. Reports telemetry using the
/// SAME continuous-socket model tsmux.rs uses for raw-TS (open/sbytes/close) rather than the manifest-poll
/// viewer/bytes model — HDHomeRun is a single long-lived connection per viewer, exactly what that model is
/// for, and it's what actually drives Node's Active Streams / History for this shape of stream. Each
/// attached viewer (whether it's the one that opened the real tuner or a later one just joining the
/// broadcast) gets its OWN stream_id, so N viewers of one shared channel correctly show as N active-stream
/// entries even though only one real upstream connection exists.
fn viewer_response(
    rx: broadcast::Receiver<Chunk>,
    viewers: Arc<AtomicUsize>,
    content_type: String,
    ctx: TelemetryCtx,
) -> Response {
    let stream_id = ctx.state.next_stream_id();
    log::info("tuner", &ctx.rid, || format!("viewer session open ({stream_id}) for {}", ctx.entry));
    ctx.state.report(serde_json::json!({
        "kind": "open", "streamId": stream_id, "source": ctx.source, "entryUrl": ctx.entry,
        "ip": ctx.ip, "ua": ctx.ua, "username": ctx.username, "playerType": "externalPlayer",
    }));
    let bytes = Arc::new(AtomicU64::new(0));
    let mut last_flush = Instant::now();
    let guard = ViewerGuard { viewers, state: ctx.state.clone(), stream_id: stream_id.clone(), bytes: bytes.clone() };
    let mapped = BroadcastStream::new(rx).filter_map(move |item| {
        let _keep_alive = &guard; // holds the guard for the stream's lifetime; dropped with the stream
        match item {
            Ok(Chunk::Data(b)) => {
                bytes.fetch_add(b.len() as u64, Ordering::Relaxed);
                // Periodic flush (same 1s cadence as tsmux.rs) so a long-lived view shows a smooth egress
                // rate in History/Metrics instead of one giant burst reported at close.
                if last_flush.elapsed() >= Duration::from_secs(1) {
                    let pending = bytes.swap(0, Ordering::Relaxed);
                    if pending > 0 {
                        guard.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending }));
                    }
                    last_flush = Instant::now();
                }
                Some(Ok(b))
            }
            Ok(Chunk::Err(e)) => Some(Err(io::Error::other(e))),
            // A slow viewer fell behind the shared ring buffer. MPEG-TS is self-synchronizing (a player
            // resyncs on the next PAT/PMT), so skipping the gap is far less disruptive than ending the
            // whole connection over it — the standalone (non-shared) path has no equivalent concept since
            // it has only one consumer and therefore can't lag.
            Err(_lagged) => None,
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "no-store")
        .body(Body::from_stream(mapped))
        .unwrap()
}
