//! RSL-3 segment streaming — the counted, optionally-buffered, stall-guarded pipe that replaces the P1 direct
//! `Body::from_stream(resp.bytes_stream())`. One bounded `tokio::sync::mpsc` sits between the upstream byte
//! stream and the client so brief upstream jitter is absorbed (bounded read-ahead, depth from `bufferSizeKb`)
//! and so we can measure the TRUE egress — including chunked / no-Content-Length segments the P1 header-based
//! count missed (that undercount also produced FALSE client-side buffering in streamTelemetry.tick step 2b,
//! now cured). A per-chunk IDLE timeout (`readTimeoutMs`) turns an upstream stall into a clean truncation + a
//! transient telemetry event instead of a hang; a mid-stream upstream error is reported the same way; a client
//! disconnect ends the pump and still reports the partial bytes actually delivered. All telemetry is
//! fire-and-forget via `AppState::report` (batched).

use axum::body::Body;
use bytes::Bytes;
use std::io;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::log;
use crate::state::AppState;

/// Telemetry attribution for one segment stream (mirrors the fields the P1 `bytes` event carried).
pub struct TelemetryCtx {
    pub state: AppState,
    pub source: String,
    pub entry: String,
    pub rid: String, // the viewing-session lineage id (for the segment's byte/outcome trace lines)
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
}

impl TelemetryCtx {
    /// Emit the segment's outcome ONCE, when the pump ends (EOF, error, stall, or client disconnect): the
    /// ACCURATE delivered byte total (drives noteBytes + keeps the channel live), and — if the upstream
    /// errored/stalled mid-body — a transient upstream failure (status 0 ⇒ noteFailure ⇒ an upstream rebuffer).
    fn finish(&self, total: u64, errored: bool) {
        if errored {
            log::warn("stream", &self.rid, || format!("segment ended on an upstream stall/error after {total} bytes"));
        } else {
            log::trace("stream", &self.rid, || format!("segment done ({total} bytes)"));
        }
        if total > 0 {
            self.state.report(serde_json::json!({
                "kind": "bytes", "source": self.source, "entryUrl": self.entry,
                "ip": self.ip, "ua": self.ua, "username": self.username, "bytes": total,
            }));
        }
        if errored {
            self.state.report(serde_json::json!({
                "kind": "upstream", "ok": false, "status": 0, "source": self.source, "entryUrl": self.entry,
            }));
        }
    }
}

// Read-ahead depth (in chunks) for the bounded buffer. `bufferSizeKb` (when set) picks the depth against a
// nominal chunk size; unset (0) → a shallow 2-chunk pipeline that behaves ~like the P1 direct pipe.
const DEFAULT_READAHEAD_CHUNKS: usize = 2;
const NOMINAL_CHUNK_KB: u64 = 64;
const MAX_READAHEAD_CHUNKS: usize = 4096;

pub(crate) fn channel_capacity(buffer_size_kb: u64) -> usize {
    if buffer_size_kb == 0 {
        DEFAULT_READAHEAD_CHUNKS
    } else {
        ((buffer_size_kb / NOMINAL_CHUNK_KB) as usize).clamp(2, MAX_READAHEAD_CHUNKS)
    }
}

/// Build the axum response Body for a segment/non-manifest upstream: spawn a pump that drains `resp` into a
/// bounded channel (counting bytes, applying the idle timeout, reporting the outcome) and return a Body that
/// streams the channel to the client. Dropping the Body (client disconnect) drops the receiver, so the pump's
/// next `send` fails and it tears down — reporting the partial bytes + closing the upstream connection.
pub fn segment_body(
    resp: reqwest::Response,
    ctx: TelemetryCtx,
    read_timeout_ms: u64,
    buffer_size_kb: u64,
) -> Body {
    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(channel_capacity(buffer_size_kb));
    let idle = if read_timeout_ms > 0 {
        Some(Duration::from_millis(read_timeout_ms))
    } else {
        None
    };
    tokio::spawn(pump(resp, tx, ctx, idle));
    Body::from_stream(ReceiverStream::new(rx))
}

async fn pump(
    resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    ctx: TelemetryCtx,
    idle: Option<Duration>,
) {
    // Box::pin so StreamExt::next (which needs Unpin) can drive reqwest's bytes_stream; resp is moved in and
    // stays alive for the pump's lifetime, so the upstream connection closes exactly when the pump ends.
    let mut stream = Box::pin(resp.bytes_stream());
    let mut total: u64 = 0;
    let mut errored = false;
    loop {
        let next = match idle {
            Some(d) => match tokio::time::timeout(d, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    // Idle-timeout: the upstream went silent mid-segment. Signal the client with an error (a
                    // truncated segment; the player refetches) and mark it a transient upstream failure.
                    errored = true;
                    let _ = tx
                        .send(Err(io::Error::new(io::ErrorKind::TimedOut, "upstream stalled")))
                        .await;
                    break;
                }
            },
            None => stream.next().await,
        };
        match next {
            Some(Ok(chunk)) => {
                total += chunk.len() as u64;
                if tx.send(Ok(chunk)).await.is_err() {
                    break; // client disconnected (receiver dropped) — stop reading upstream
                }
            }
            Some(Err(e)) => {
                errored = true;
                let _ = tx.send(Err(io::Error::other(e.to_string()))).await;
                break;
            }
            None => break, // clean EOF
        }
    }
    ctx.finish(total, errored);
}

/// Telemetry attribution for a continuous raw-passthrough ENTRY stream (no manifest at all — e.g. an
/// HDHomeRun tuner's raw MPEG-TS, or any other adapter whose entry URL IS the playable media with nothing
/// to poll). Unlike a HOP/segment (a short, self-contained fetch reported once at `finish`), this pipe can
/// stay open for the entire viewing session, so it uses the SOCKET model (open → Node mints a connId;
/// periodic `sbytes` → egress; `close` → session end) — the same model tsmux.rs already uses for its raw-TS
/// producer — instead of the poll-recency model, so the channel shows as an Active Stream immediately and
/// its egress flows out continuously, not just once at disconnect.
pub struct SocketTelemetryCtx {
    pub state: AppState,
    pub source: String,
    pub entry: String,
    pub rid: String,
    pub ip: String,
    pub ua: String,
    pub username: Option<String>,
    pub player_type: String, // "appPlayer" | "externalPlayer"
}

// How often a live socket session flushes its accumulated egress (mirrors tsmux's 1s cadence) so Active
// Streams shows a real-time rate instead of one lump sum at the end of a potentially hours-long tune.
const SOCKET_FLUSH_INTERVAL: Duration = Duration::from_secs(1);

/// Build the axum response Body for a continuous raw-passthrough ENTRY: reports `open` immediately (so the
/// channel shows as an Active Stream from the first byte), pumps the upstream body into the client with a
/// periodic `sbytes` flush, and reports `close` when the pipe ends (EOF, error, stall, or client disconnect).
pub fn raw_socket_body(
    resp: reqwest::Response,
    ctx: SocketTelemetryCtx,
    read_timeout_ms: u64,
    buffer_size_kb: u64,
) -> Body {
    let stream_id = ctx.state.next_stream_id();
    log::info("stream", &ctx.rid, || format!("raw-socket session open ({stream_id})"));
    ctx.state.report(serde_json::json!({
        "kind": "open", "streamId": stream_id, "source": ctx.source, "entryUrl": ctx.entry,
        "ip": ctx.ip, "ua": ctx.ua, "username": ctx.username, "playerType": ctx.player_type,
    }));
    let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(channel_capacity(buffer_size_kb));
    let idle = if read_timeout_ms > 0 {
        Some(Duration::from_millis(read_timeout_ms))
    } else {
        None
    };
    tokio::spawn(socket_pump(resp, tx, ctx, stream_id, idle));
    Body::from_stream(ReceiverStream::new(rx))
}

async fn socket_pump(
    resp: reqwest::Response,
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    ctx: SocketTelemetryCtx,
    stream_id: String,
    idle: Option<Duration>,
) {
    let mut stream = Box::pin(resp.bytes_stream());
    let mut pending_bytes: u64 = 0;
    let mut last_flush = Instant::now();
    let mut errored = false;
    loop {
        let next = match idle {
            Some(d) => match tokio::time::timeout(d, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    errored = true;
                    let _ = tx
                        .send(Err(io::Error::new(io::ErrorKind::TimedOut, "upstream stalled")))
                        .await;
                    break;
                }
            },
            None => stream.next().await,
        };
        match next {
            Some(Ok(chunk)) => {
                pending_bytes += chunk.len() as u64;
                if tx.send(Ok(chunk)).await.is_err() {
                    break; // client disconnected — stop reading upstream
                }
            }
            Some(Err(e)) => {
                errored = true;
                let _ = tx.send(Err(io::Error::other(e.to_string()))).await;
                break;
            }
            None => break, // clean EOF
        }
        if pending_bytes > 0 && last_flush.elapsed() >= SOCKET_FLUSH_INTERVAL {
            ctx.state.report(serde_json::json!({
                "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes,
            }));
            pending_bytes = 0;
            last_flush = Instant::now();
        }
    }
    if pending_bytes > 0 {
        ctx.state.report(serde_json::json!({ "kind": "sbytes", "streamId": stream_id, "bytes": pending_bytes }));
    }
    if errored {
        log::warn("stream", &ctx.rid, || "raw-socket session ended on an upstream stall/error".to_string());
        ctx.state.report(serde_json::json!({
            "kind": "upstream", "ok": false, "status": 0, "source": ctx.source, "entryUrl": ctx.entry,
        }));
    } else {
        log::trace("stream", &ctx.rid, || "raw-socket session ended cleanly (upstream EOF)".to_string());
    }
    log::info("stream", &ctx.rid, || format!("raw-socket session close ({stream_id})"));
    ctx.state.report(serde_json::json!({ "kind": "close", "streamId": stream_id }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_disabled_is_shallow() {
        assert_eq!(channel_capacity(0), DEFAULT_READAHEAD_CHUNKS);
    }

    #[test]
    fn capacity_scales_with_buffer_kb() {
        assert_eq!(channel_capacity(1024), 16); // 1024KB / 64KB nominal = 16 chunks
    }

    #[test]
    fn capacity_has_a_floor_and_ceiling() {
        assert_eq!(channel_capacity(16), 2); // 16/64 = 0 → floored to 2
        assert_eq!(channel_capacity(1_048_576), MAX_READAHEAD_CHUNKS); // huge → clamped
    }
}
