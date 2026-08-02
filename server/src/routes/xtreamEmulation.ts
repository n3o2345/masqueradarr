import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { User, type UserDoc } from '../models/User.js';
import { verifyPassword } from '../security/crypto.js';
import { channelsForUser, channelsForUserCustom, resolveDomain } from '../m3u/compose.js';
import { channelPlayUrl } from '../m3u/serialize.js';
import { fetchProgramsGrouped } from '../epg/queryPrograms.js';
import { GLOBAL_GUIDE_PATH, customGuidePath, guideDiskPath } from '../epg/guidePaths.js';
import { loadConfig } from '../config.js';
import { logger } from '../sources/core/logger.js';
import type { PlaylistChannelDoc } from '../models/PlaylistChannel.js';
import type { HydratedDocument } from 'mongoose';

// Internal Node port (same resolution index.ts uses) — /live/... pipes the stream through a LOOPBACK fetch
// of the normal /api/ext/v1/... proxy URL rather than 302-redirecting the client to it (see serveStream
// below for why). Read once at module load; loadConfig() does a small synchronous file read, not per-request.
const NODE_PORT = loadConfig().port;

// XTREAM CODES API EMULATION — makes Masqueradarr addable as an Xtream Codes ("Xtream Login") IPTV provider
// by anything that speaks that protocol (TiviMate, IPTV Smarters, GSE Smart IPTV, Perfect Player, Dispatcharr's
// own "Xtream Codes API" input type, …). This is the Xtream analogue of routes/hdhomerunEmulation.ts — same
// "expose our composed channel set as a well-known API" idea, different wire protocol.
//
// SCOPE: two scopes, mirroring routes/hdhomerunEmulation.ts:
//   /player_api.php, /get.php, /xmltv.php, /live/...                 the Global union (channelsForUser).
//   /xc/:customId/player_api.php, /xc/:customId/get.php, ...         ONE Custom playlist (channelsForUserCustom),
//                                                                     e.g. "Satellite" — additionally gated by
//                                                                     that playlist's own xtreamEnabled toggle
//                                                                     (models/Playlist.ts), OFF by default. An
//                                                                     operator opts a Custom playlist in via
//                                                                     PUT /api/playlists/:id { xtreamEnabled }.
//                                                                     :customId is the Playlist.id (same value
//                                                                     the HDHR Custom scope's :customId is).
// No VOD/series library is emulated in either scope (Masqueradarr has none) — get_vod_*/get_series* actions
// report empty.
//
// AUTH MODEL: unlike the HDHR emulation (which reuses the slug-in-URL / streamToken bearer scheme because
// HDHR clients can't do interactive login), Xtream clients always prompt for a username + password, so this
// router verifies real account credentials (User.passwordHash via verifyPassword) — the SAME credentials used
// to log into the Web UI — rather than minting a separate Xtream-only secret. streamTokenEnabled still gates
// access exactly like every other stream surface.
//
// STREAM DELIVERY: Xtream's wire format needs a small positive integer `stream_id` per channel (not our
// string PlaylistChannel id), and a fixed-shape `/live/<user>/<pass>/<stream_id>.<ext>` play URL. Rather than
// stand up a second stream pipeline, `/live/...` resolves the numeric id back to a channel (via a stable
// hash — see streamIdFor) and 302-redirects to the SAME /api/ext/v1/... proxy URL the .m3u export and the
// HDHR emulation already use (m3u/serialize.ts channelPlayUrl), token baked in. That keeps exactly one
// stream-access gate (middleware/streamGate.ts + proxy/relay.ts) for every surface — this router only ever
// produces a redirect, never proxies bytes itself. Any Xtream client (this includes every mainstream one) that
// follows a 302 on a live-TV URL works unmodified.
//
// Mounted at root (NOT under /api — see index.ts), so it sits outside the `authenticate` middleware entirely;
// the Xtream username/password IS the auth, checked per-request against the User collection.

export const xtreamEmulationRouter = Router();

type UserHydrated = HydratedDocument<UserDoc>;

// ---------------------------------------------------------------------------
// Credential + id helpers
// ---------------------------------------------------------------------------

// Verify Xtream-supplied username/password against the real account (same passwordHash the Web UI login
// checks), gated by streamTokenEnabled like every other stream-serving surface. Case-insensitive on username
// to match User.username's stored lowercase/trim normalization (schema-level lowercase only applies on save,
// not on query — so it's applied here manually, same as isValidUsername callers elsewhere).
async function userByCreds(username: unknown, password: unknown): Promise<UserHydrated | null> {
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) return null;
  const user = await User.findOne({ username: username.trim().toLowerCase() });
  if (!user || !user.streamTokenEnabled) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return user;
}

// Stable, deterministic small positive integer derived from a string — no DB-stored mapping needed (mirrors
// hdhomerunEmulation.ts's deviceIdFor). 7 hex chars (28 bits, max 268,435,455) comfortably fits the signed-
// 32-bit int field every Xtream client assumes for stream_id/category_id, while staying effectively
// collision-free for one operator's channel/group count.
function hashInt(seed: string): number {
  return parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 7), 16);
}

function streamIdFor(ch: PlaylistChannelDoc): number {
  return hashInt(`xtream-stream:${ch.id}`);
}

function categoryIdFor(group: string | null): string {
  return group == null ? '0' : String(hashInt(`xtream-cat:${group}`));
}

// Only Active, non-failover-child channels are ever exposed — same inclusion rule as channelPlayUrl/
// channelToExtinf (m3u/serialize.ts §5) so the Xtream surface never advertises a channel the M3U export
// would have omitted.
function liveEligible(ch: PlaylistChannelDoc): boolean {
  return ch.status === 'Active' && ch.failoverRole !== 'child';
}

async function findLiveChannel(user: UserHydrated, streamId: number): Promise<PlaylistChannelDoc | null> {
  const channels = await channelsForUser(user);
  return channels.find((ch) => liveEligible(ch) && streamIdFor(ch) === streamId) ?? null;
}

// Custom-playlist analogue of channelsForUser's role above: resolves ONE Custom playlist's channel set for
// this user, gated by BOTH the playlist's own xtreamEnabled toggle (models/Playlist.ts — an operator
// killswitch, off by default) and the usual admin || allowedCustomPlaylists membership check
// (channelsForUserCustom's own gate). Returns null when the customId doesn't resolve to a Custom playlist AT
// ALL, or that playlist has xtreamEnabled !== true — the two cases are indistinguishable to the caller by
// design, same as an unknown vs. a not-yet-configured route. A real, XC-enabled Custom playlist the user
// isn't permitted to see returns an EMPTY array (channelsForUserCustom's own membership gate), not null —
// mirrors how the HDHR Custom scope's lineup.json behaves for the same case.
async function resolveCustomChannels(user: UserHydrated, customId: string): Promise<PlaylistChannelDoc[] | null> {
  const resolved = await channelsForUserCustom(user, customId);
  if (!resolved || resolved.playlist.xtreamEnabled !== true) return null;
  return resolved.channels;
}

async function findCustomLiveChannel(
  user: UserHydrated,
  customId: string,
  streamId: number,
): Promise<PlaylistChannelDoc | null> {
  const channels = await resolveCustomChannels(user, customId);
  if (!channels) return null;
  return channels.find((ch) => liveEligible(ch) && streamIdFor(ch) === streamId) ?? null;
}

// Strip embedded quotes/CR/LF that would corrupt an EXTINF attribute or break JSON string values pulled
// straight from operator-entered fields (tvg_name, group, logoUrl) — mirrors m3u/serialize.ts's `clean`.
function clean(v: string): string {
  return v.replace(/[\r\n"]/g, '');
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// player_api.php payload builders
// ---------------------------------------------------------------------------

function buildServerInfo(domain: string, nowSec: number): Record<string, unknown> {
  let host = domain;
  let port = '80';
  let httpsPort = '443';
  const isHttps = domain.startsWith('https');
  try {
    const u = new URL(domain);
    host = u.hostname;
    if (isHttps) httpsPort = u.port || '443';
    else port = u.port || '80';
  } catch {
    // domain wasn't a full URL (shouldn't happen — resolveDomain always returns one) — fall back to the raw string.
  }
  return {
    url: host,
    port,
    https_port: httpsPort,
    server_protocol: isHttps ? 'https' : 'http',
    rtmp_port: '0',
    timezone: 'UTC',
    timestamp_now: nowSec,
    time_now: fmtDate(nowSec * 1000),
  };
}

function buildUserInfo(user: UserHydrated, password: string): Record<string, unknown> {
  return {
    username: user.username,
    password,
    message: '',
    auth: 1,
    status: 'Active',
    exp_date: null, // no expiry concept — mirrors streamTokenEnabled being the only access switch
    is_trial: '0',
    active_cons: '0',
    created_at: String(Math.floor((user.createdAt?.getTime() ?? Date.now()) / 1000)),
    max_connections: '0', // '0' is Xtream convention for "unlimited"
    allowed_output_formats: ['ts', 'm3u8'],
  };
}

function buildCategories(channels: PlaylistChannelDoc[]): Array<Record<string, unknown>> {
  const byId = new Map<string, string>(); // category_id -> category_name, de-duplicated
  for (const ch of channels) {
    if (!liveEligible(ch) || ch.group == null) continue;
    byId.set(categoryIdFor(ch.group), ch.group);
  }
  return [...byId.entries()].map(([category_id, category_name]) => ({
    category_id,
    category_name,
    parent_id: 0,
  }));
}

function buildLiveStreams(channels: PlaylistChannelDoc[], categoryId?: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let num = 1;
  for (const ch of channels) {
    if (!liveEligible(ch)) continue;
    const catId = categoryIdFor(ch.group);
    if (categoryId && catId !== categoryId) continue;
    out.push({
      num: num++,
      name: ch.tvg_name,
      stream_type: 'live',
      stream_id: streamIdFor(ch),
      stream_icon: ch.logoUrl ?? '',
      epg_channel_id: ch.tvg_id ?? '',
      added: '0',
      category_id: catId,
      category_ids: [Number(catId)],
      custom_sid: '',
      tv_archive: 0,
      direct_source: '',
      tv_archive_duration: 0,
      thumbnail: ch.logoUrl ?? '',
    });
  }
  return out;
}

// Xtream's get_short_epg/get_simple_data_table base64-encode title/description (a long-standing quirk of the
// original protocol that every client still expects). Only channels with a real 2-factor EPG link (tvg_id +
// epg both set — same gate channelToExtinf uses for tvg-id) have any listings; an unlinked channel yields [].
async function shortEpgFor(ch: PlaylistChannelDoc, limit: number): Promise<Array<Record<string, unknown>>> {
  if (ch.tvg_id == null || ch.epg == null) return [];
  const key = `${ch.epg}:${ch.tvg_id}`;
  const now = Date.now();
  const grouped = await fetchProgramsGrouped([key], now - 2 * 3_600_000, now + 24 * 3_600_000);
  const programs = (grouped[key] ?? []).slice(0, limit);
  const channelId = String(streamIdFor(ch));
  return programs.map((p, i) => ({
    id: String(i + 1),
    epg_id: '0',
    title: Buffer.from(p.title, 'utf8').toString('base64'),
    lang: '',
    start: fmtDate(p.start),
    end: fmtDate(p.end),
    description: Buffer.from('', 'utf8').toString('base64'), // GroupedProgram carries no description field
    channel_id: channelId,
    start_timestamp: String(Math.floor(p.start / 1000)),
    stop_timestamp: String(Math.floor(p.end / 1000)),
    now_playing: p.start <= now && now < p.end ? 1 : 0,
    has_archive: 0,
  }));
}

// Builds the Xtream-flavored M3U body for either scope — `liveBase` is the scope's /live path prefix
// ('/live' for Global, '/xc/:customId/live' for Custom) so the emitted URLs land back on the right scope.
function buildM3u(
  channels: PlaylistChannelDoc[],
  domain: string,
  username: string,
  password: string,
  liveBase: string,
): string {
  const lines: string[] = ['#EXTM3U'];
  for (const ch of channels) {
    const attrs: string[] = [];
    if (ch.tvg_id != null && ch.epg != null) attrs.push(`tvg-id="${clean(ch.tvg_id)}"`);
    attrs.push(`tvg-name="${clean(ch.tvg_name)}"`);
    if (ch.logoUrl != null) attrs.push(`tvg-logo="${clean(ch.logoUrl)}"`);
    attrs.push(`group-title="${clean(ch.group ?? '')}"`);
    const url = `${domain}${liveBase}/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamIdFor(ch)}.ts`;
    lines.push(`#EXTINF:-1 ${attrs.join(' ')},${clean(ch.tvg_name)}`);
    lines.push(url);
  }
  return lines.join('\n') + '\n';
}

async function sendGuide(res: express.Response, servedPath: string): Promise<void> {
  try {
    const xml = await readFile(guideDiskPath(servedPath));
    res.type('application/xml').send(xml);
  } catch {
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><tv></tv>');
  }
}

// Strips whatever extension the client appended (.ts, .m3u8, .m4a, …) — Xtream clients pick it themselves
// and expect the server to honor whichever one they chose, so it's accepted and ignored either way.
function parseStreamId(raw: string): number | null {
  const n = Number(raw.replace(/\.[a-zA-Z0-9]+$/, ''));
  return Number.isFinite(n) ? n : null;
}

// Serves the stream directly rather than 302-redirecting the client to /api/ext/v1/... — confirmed necessary
// for at least one real client (iMPlayer): it loads the channel list from player_api.php fine (that's just
// JSON) but never starts playback, because it doesn't follow a redirect on the actual video request. Not an
// uncommon limitation among simpler Xtream players, so this pipes bytes through unconditionally rather than
// relying on client redirect support.
//
// Implementation: a LOOPBACK fetch of the exact same /api/ext/v1/... URL the redirect used to point at
// (127.0.0.1:NODE_PORT, bypassing the public reverse proxy for this internal hop), then stream the response
// straight through — same status/header-forwarding + body-piping shape as proxy/relay.ts's Node→sidecar
// relay, just one level up the chain (client→Node→[Node loopback]→sidecar instead of client→sidecar
// directly). This keeps the streamGate/authenticate token check exactly as-is (still just the ?token= query
// param the loopback URL carries), so no gate logic is duplicated or bypassed here.
async function serveStream(
  req: express.Request,
  res: express.Response,
  ch: PlaylistChannelDoc | null,
  token?: string,
): Promise<void> {
  if (!ch) {
    res.status(404).type('text/plain').send('Unknown stream');
    return;
  }
  const url = channelPlayUrl(ch, `http://127.0.0.1:${NODE_PORT}`, token);
  if (!url) {
    res.status(404).type('text/plain').send('Stream unavailable');
    return;
  }

  const headers: Record<string, string> = {};
  const range = req.headers['range'];
  if (typeof range === 'string') headers['range'] = range;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  } catch (err) {
    logger.warn('xtream', `loopback stream fetch failed (${url.slice(0, 80)}): ${(err as Error).message}`);
    if (!res.headersSent) res.status(502).type('text/plain').send('stream engine unavailable');
    return;
  }

  res.status(upstream.status);
  for (const h of ['content-type', 'cache-control', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
  body.on('error', (err) => {
    logger.warn('xtream', `loopback stream error: ${err.message}`);
    res.destroy(err);
  });
  body.pipe(res);
}

// ---------------------------------------------------------------------------
// player_api.php / panel_api.php — GET (query string) and POST (JSON or form) both accepted; real clients
// use either depending on version. No `action` = the login/handshake call (user_info + server_info only).
// Shared between the Global scope (channels = channelsForUser) and each Custom scope (channels =
// resolveCustomChannels) below — the action set and payload shapes are identical either way, only which
// channels are visible differs.
// ---------------------------------------------------------------------------

async function respondToAction(
  res: express.Response,
  action: string,
  params: Record<string, unknown>,
  fetchChannels: () => Promise<PlaylistChannelDoc[]>,
): Promise<void> {
  switch (action) {
    case 'get_live_categories':
      res.json(buildCategories(await fetchChannels()));
      return;
    case 'get_live_streams': {
      const categoryId = typeof params.category_id === 'string' ? params.category_id : undefined;
      res.json(buildLiveStreams(await fetchChannels(), categoryId));
      return;
    }
    case 'get_vod_categories':
    case 'get_vod_streams':
    case 'get_series_categories':
    case 'get_series':
      // Masqueradarr is live-channel-only — no VOD/series library to report, so these are always empty
      // rather than 404s (an Xtream client treats an unrecognized action worse than an empty catalog).
      res.json([]);
      return;
    case 'get_short_epg':
    case 'get_simple_data_table': {
      const streamId = Number(params.stream_id);
      const limit = action === 'get_short_epg' ? Number(params.limit) || 4 : 200;
      let ch: PlaylistChannelDoc | null = null;
      if (Number.isFinite(streamId)) {
        const channels = await fetchChannels();
        ch = channels.find((c) => liveEligible(c) && streamIdFor(c) === streamId) ?? null;
      }
      res.json({ epg_listings: ch ? await shortEpgFor(ch, limit) : [] });
      return;
    }
    default:
      res.json({});
  }
}

function mergedParams(req: express.Request): Record<string, unknown> {
  return { ...req.query, ...(typeof req.body === 'object' && req.body ? req.body : {}) };
}

// ── Global scope ─────────────────────────────────────────────────────────────

async function handlePlayerApi(req: express.Request, res: express.Response): Promise<void> {
  const params = mergedParams(req);
  const user = await userByCreds(params.username, params.password);
  if (!user) {
    // Xtream convention: a failed login is a 200 with auth:0, not an HTTP error — clients key off this field.
    res.json({ user_info: { auth: 0 }, server_info: {} });
    return;
  }
  const domain = await resolveDomain();
  const nowSec = Math.floor(Date.now() / 1000);
  const action = typeof params.action === 'string' ? params.action : '';

  if (!action) {
    res.json({ user_info: buildUserInfo(user, params.password as string), server_info: buildServerInfo(domain, nowSec) });
    return;
  }
  await respondToAction(res, action, params, () => channelsForUser(user));
}

xtreamEmulationRouter.get('/player_api.php', handlePlayerApi);
xtreamEmulationRouter.get('/panel_api.php', handlePlayerApi); // some clients (notably TiviMate) probe this alias first
xtreamEmulationRouter.post('/player_api.php', express.urlencoded({ extended: false }), handlePlayerApi);
xtreamEmulationRouter.post('/panel_api.php', express.urlencoded({ extended: false }), handlePlayerApi);

// ---------------------------------------------------------------------------
// get.php — the Xtream-flavored M3U (type=m3u_plus&output=ts, the two values every client sends; both are
// accepted but ignored since we always emit the same /live/... URL shape regardless). Distinct from the
// existing per-user .m3u export (m3u/compose.ts): THIS file's URLs point at /live/<user>/<pass>/<id>.ts
// (the Xtream play-URL contract), not the bare /api/ext/v1/... proxy path the "native" export uses.
// ---------------------------------------------------------------------------

xtreamEmulationRouter.get('/get.php', async (req, res) => {
  const { username, password } = req.query;
  const user = await userByCreds(username, password);
  if (!user) {
    res.status(401).type('text/plain').send('Invalid credentials');
    return;
  }
  const domain = await resolveDomain();
  const channels = (await channelsForUser(user)).filter(liveEligible);
  res.type('audio/mpegurl').send(buildM3u(channels, domain, username as string, password as string, '/live'));
});

// ---------------------------------------------------------------------------
// xmltv.php — the shared Global XMLTV guide, same file the .m3u export's x-tvg-url already points at
// (epg/composeGuide.ts / GLOBAL_GUIDE_PATH). Served as-is; a guide superset of the user's own channel set is
// harmless (same reasoning m3u/compose.ts documents for the per-user Global .m3u header).
// ---------------------------------------------------------------------------

xtreamEmulationRouter.get('/xmltv.php', async (req, res) => {
  const user = await userByCreds(req.query.username, req.query.password);
  if (!user) {
    res.status(401).type('text/plain').send('Invalid credentials');
    return;
  }
  await sendGuide(res, GLOBAL_GUIDE_PATH);
});

// ---------------------------------------------------------------------------
// /live/:username/:password/:streamId(.ext) — the actual play URL. Any extension the client appends (.ts,
// .m3u8, .m4a, …) is accepted and ignored; Xtream clients pick the extension themselves and expect the
// server to honor whichever one they chose. Resolves the numeric id back to a channel, then 302s to the
// SAME /api/ext/v1/... proxy URL every other export surface uses — see the file header for why.
// ---------------------------------------------------------------------------

xtreamEmulationRouter.get('/live/:username/:password/:streamId', async (req, res) => {
  const user = await userByCreds(req.params.username, req.params.password);
  if (!user) {
    res.status(401).type('text/plain').send('Invalid credentials');
    return;
  }
  const streamId = parseStreamId(req.params.streamId);
  const ch = streamId != null ? await findLiveChannel(user, streamId) : null;
  await serveStream(req, res, ch, user.streamToken);
});

// ---------------------------------------------------------------------------
// Custom-playlist scope: /xc/:customId/... — mirrors every route above, but scoped to ONE Custom playlist via
// resolveCustomChannels (both that playlist's xtreamEnabled toggle AND the requesting user's
// allowedCustomPlaylists membership must hold). :customId is the Playlist.id — the same value shown in that
// playlist's own "HOSTED AT" URL / admin UI, and the same id the HDHR Custom scope's :customId is.
// ---------------------------------------------------------------------------

async function handleCustomPlayerApi(req: express.Request, res: express.Response): Promise<void> {
  const customId = String(req.params.customId);
  const params = mergedParams(req);
  const user = await userByCreds(params.username, params.password);
  if (!user) {
    res.json({ user_info: { auth: 0 }, server_info: {} });
    return;
  }
  const channels = await resolveCustomChannels(user, customId);
  if (!channels) {
    // Unknown Custom playlist OR xtreamEnabled is off for it — same generic failure as bad credentials,
    // so this endpoint never reveals whether a disabled/nonexistent id exists.
    res.json({ user_info: { auth: 0 }, server_info: {} });
    return;
  }
  const domain = await resolveDomain();
  const nowSec = Math.floor(Date.now() / 1000);
  const action = typeof params.action === 'string' ? params.action : '';

  if (!action) {
    res.json({ user_info: buildUserInfo(user, params.password as string), server_info: buildServerInfo(domain, nowSec) });
    return;
  }
  await respondToAction(res, action, params, async () => channels);
}

xtreamEmulationRouter.get('/xc/:customId/player_api.php', handleCustomPlayerApi);
xtreamEmulationRouter.get('/xc/:customId/panel_api.php', handleCustomPlayerApi);
xtreamEmulationRouter.post('/xc/:customId/player_api.php', express.urlencoded({ extended: false }), handleCustomPlayerApi);
xtreamEmulationRouter.post('/xc/:customId/panel_api.php', express.urlencoded({ extended: false }), handleCustomPlayerApi);

xtreamEmulationRouter.get('/xc/:customId/get.php', async (req, res) => {
  const { username, password } = req.query;
  const user = await userByCreds(username, password);
  if (!user) {
    res.status(401).type('text/plain').send('Invalid credentials');
    return;
  }
  const channels = await resolveCustomChannels(user, req.params.customId);
  if (!channels) {
    res.status(404).type('text/plain').send('Unknown playlist');
    return;
  }
  const domain = await resolveDomain();
  const base = `/xc/${req.params.customId}/live`;
  res
    .type('audio/mpegurl')
    .send(buildM3u(channels.filter(liveEligible), domain, username as string, password as string, base));
});

xtreamEmulationRouter.get('/xc/:customId/xmltv.php', async (req, res) => {
  const user = await userByCreds(req.query.username, req.query.password);
  if (!user) {
    res.status(401).type('text/plain').send('Invalid credentials');
    return;
  }
  const resolved = await channelsForUserCustom(user, req.params.customId);
  if (!resolved || resolved.playlist.xtreamEnabled !== true) {
    res.status(404).type('text/plain').send('Unknown playlist');
    return;
  }
  await sendGuide(res, customGuidePath(resolved.playlist.url));
});

xtreamEmulationRouter.get('/xc/:customId/live/:username/:password/:streamId', async (req, res) => {
  const user = await userByCreds(req.params.username, req.params.password);
  if (!user) {
    res.status(401).type('text/plain').send('Invalid credentials');
    return;
  }
  const streamId = parseStreamId(req.params.streamId);
  const ch = streamId != null ? await findCustomLiveChannel(user, req.params.customId, streamId) : null;
  await serveStream(req, res, ch, user.streamToken);
});
