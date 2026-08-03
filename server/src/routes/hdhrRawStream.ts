import { Router } from 'express';
import { Readable } from 'node:stream';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { userFromToken } from '../middleware/auth.js';
import { logger } from '../sources/core/logger.js';
import {
  nextSocketConnId,
  noteSocketViewerOpen,
  noteSocketBytes,
  noteSocketViewerClose,
} from '../sources/core/streamTelemetry.js';
import { streamKey, noteSuccess, noteFailed } from '../sources/core/streamState.js';
import type { UserDoc } from '../models/User.js';

// DEDICATED raw-TS passthrough for origin:'hdhomerun' channels (sources/adapters/hdhomerun/import.ts's
// HDHR_ORIGIN), used by m3u/serialize.ts's channelPlayUrl INSTEAD OF the generic /api/ext/v1/<source>/
// <entryUrl> proxy scheme every other channel gets.
//
// WHY: the generic scheme's outer URL ends in whatever the device's own path happens to end in — an
// HDHomeRun sub-channel path like /auto/v3.2 or /auto/v26.5 — so the outer proxy URL ends in a bare ".2" or
// ".5" right before the query string. Confirmed against a real client (iMPlayer): it silently refuses to
// even ATTEMPT a URL whose path doesn't end in a media extension it recognizes (.ts/.m3u8/…) — no request
// ever reaches the server, which reads as "playback just doesn't start" with nothing to diagnose server-side.
// Channels on every OTHER source happen to end in a real extension (typically .m3u8) inside their own
// upstream URL, which is why only HDHomeRun-origin channels hit this. There's no way to safely bolt a real
// extension onto the generic scheme's URL — appending anything to the encoded entry segment changes the
// ACTUAL request sent to the tuner (e.g. turns /auto/v3.2 into /auto/v3.2.ts, which the device 404s), and
// that scheme's routing (source/entry as exactly two path segments) is owned by the Rust sidecar, not
// something this Node app can safely reshape. So instead: a small, ENTIRELY Node-side route, independent of
// the sidecar, that always ends in a literal ".ts" and fetches the device directly — mirrors the adapter's
// own "identity passthrough" description (sources/adapters/hdhomerun/index.ts): no transcode, just proxy the
// device's raw MPEG-TS straight through.
//
// AUTH: verifies the requesting user actually has access to the CHANNEL'S OWNING PLAYLIST — admin, or that
// playlist's id (ch.source — e.g. "HDHomeRun FLEX 4K") in allowedCustomPlaylists, or (belt-and-suspenders,
// in case an HDHomeRun channel is ever reachable via Global scope) 'hdhomerun' in allowedPlaylists. This is
// deliberately NOT gateStreamAccess(user, 'hdhomerun') (a flat allowedPlaylists-only check) — that was this
// route's first version, and it 403'd a real, legitimately-granted user ("Forbidden: you do not have access
// to this source") because their grant lived in allowedCustomPlaylists (the actual permission a Custom
// playlist's "Assign access" screen manages), a completely different field gateStreamAccess never looks at.
// By the time a request reaches here via routes/xtreamEmulation.ts's /xc/:customId/live/... it's already been
// through channelsForUserCustom's own correct allowedCustomPlaylists check — this route's check exists for
// the OTHER paths that reach it directly (the plain .m3u export, HDHR tuner emulation's lineup.json), where
// nothing has authorized the request yet.
//
// Mounted at root (see index.ts) — reachable at /hdhr-stream/<channel _id>.ts?token=...&pl=...
// (`pl` is accepted but unused here — this route has no per-playlist videoconfig branch to select, unlike
// the generic scheme's `pl=` — kept only so the URL shape stays consistent with every other export's URLs).
//
// CONFIRMED SECOND FAILURE MODE (separate from the extension-sniffing one above): the earlier iMPlayer
// redirect fix (routes/xtreamEmulation.ts's serveStream) works by having Node loopback-fetch its own
// /api/ext/v1/... URL. For every OTHER source that's fine, but for `hdhomerun` specifically the edge's own
// stream-token gate DENIES that loopback request with a 403 (`ip=127.0.0.1`) — almost certainly a deliberate
// anti-SSRF guard: a request that claims to originate from localhost AND targets a private/LAN upstream
// (exactly what an hdhomerun stream is, via `allowPrivate`) is exactly the shape of an internal-network-pivot
// attack, so the edge is right to distrust it. This route sidesteps that too — it never touches
// /api/ext/v1 or the edge at all; Node fetches the tuner directly, the same way it always legitimately would.
//
// TELEMETRY: because this route never touches the Rust proxy pipeline, nothing was reporting these streams
// to the WebUI's Active Streams / History — confirmed after the fix above got playback working. Fixed by
// calling the SAME in-process telemetry cores routes/internal.ts's /telemetry endpoint feeds (sources/core/
// streamTelemetry.ts + streamState.ts) directly, using the continuous-TS SOCKET model (one long-lived
// connection, not the HLS poll model) — the correct shape for a raw MPEG-TS passthrough like this one.

export const hdhrRawStreamRouter = Router();

const HDHR_ORIGIN = 'hdhomerun'; // mirrors sources/adapters/hdhomerun/import.ts's HDHR_ORIGIN constant

function canAccessChannel(user: UserDoc | undefined, ch: { source: string }): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if ((user.allowedCustomPlaylists ?? []).includes(ch.source)) return true;
  if ((user.allowedPlaylists ?? []).includes(HDHR_ORIGIN)) return true;
  return false;
}

hdhrRawStreamRouter.get('/hdhr-stream/:channelId', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const found = token ? await userFromToken(token) : null;

  // Strip the literal ".ts" suffix (added purely for client-side extension recognition) before decoding
  // back to the real PlaylistChannel _id. base64url, not decodeURIComponent — see m3u/serialize.ts's
  // channelPlayUrl for why: the edge in front of this app 400s a path containing percent-encoded colons
  // (%3A, from the id's "<importId>:<guideNumber>" shape), so the id is base64url-encoded there instead.
  const rawId = req.params.channelId.replace(/\.ts$/, '');
  let channelId: string;
  try {
    channelId = Buffer.from(rawId, 'base64url').toString('utf8');
  } catch {
    res.status(404).type('text/plain').send('Unknown channel');
    return;
  }

  const ch = await PlaylistChannel.findOne({ _id: channelId, origin: HDHR_ORIGIN, status: 'Active' }).lean();
  if (!ch || !ch.streamEntryUrl) {
    res.status(404).type('text/plain').send('Unknown channel');
    return;
  }

  if (!canAccessChannel(found?.user, ch)) {
    res.status(403).type('text/plain').send('Forbidden: you do not have access to this playlist');
    return;
  }

  const key = streamKey(HDHR_ORIGIN, ch.streamEntryUrl);
  let upstream: Response;
  try {
    upstream = await fetch(ch.streamEntryUrl, { method: 'GET', redirect: 'follow' });
  } catch (err) {
    noteFailed(key);
    logger.warn('hdhr-stream', `device fetch failed (${ch.streamEntryUrl}): ${(err as Error).message}`);
    if (!res.headersSent) res.status(502).type('text/plain').send('tuner unreachable');
    return;
  }

  res.status(upstream.status);
  // The device's own content-type is trusted when present (matches the adapter's relabelSegmentContentType
  // fallback of 'video/mp2t'); otherwise default to the same raw-TS type the adapter assumes.
  res.type(upstream.headers.get('content-type') || 'video/mp2t');
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) res.set('content-length', contentLength);

  if (!upstream.body) {
    if (upstream.status < 200 || upstream.status >= 300) noteFailed(key);
    res.end();
    return;
  }

  // A 2xx here is itself a success (same convention the HLS `bytes`/`viewer` telemetry events use) — register
  // the socket viewer for the WebUI's Active Streams and mark the channel live before any bytes are counted.
  // A non-2xx is a definitive upstream failure (noteFailed), same as a bad response anywhere else in the app.
  let connId: number | null = null;
  if (upstream.status >= 200 && upstream.status < 300) {
    connId = nextSocketConnId();
    const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '';
    noteSocketViewerOpen(HDHR_ORIGIN, ch.streamEntryUrl, req.ip ?? '', ua, found?.user?.username, 'externalPlayer', connId);
    noteSuccess(key);
  } else {
    noteFailed(key);
  }

  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  if (connId !== null) {
    const openConnId = connId;
    body.on('data', (chunk: Buffer) => noteSocketBytes(openConnId, chunk.length));
  }
  const closeSocket = () => {
    if (connId !== null) noteSocketViewerClose(connId);
  };
  body.on('error', (err) => {
    logger.warn('hdhr-stream', `device stream error: ${err.message}`);
    closeSocket();
    res.destroy(err);
  });
  body.on('end', closeSocket);
  res.on('close', closeSocket); // covers a client disconnect before the upstream body itself ends
  body.pipe(res);
});
