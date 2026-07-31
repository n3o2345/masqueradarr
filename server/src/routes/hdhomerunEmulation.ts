import { Router } from 'express';
import { createHash } from 'node:crypto';
import { User } from '../models/User.js';
import { channelsForUser, channelsForUserCustom, resolveDomain } from '../m3u/compose.js';
import { channelPlayUrl } from '../m3u/serialize.js';
import type { PlaylistChannelDoc } from '../models/PlaylistChannel.js';

// HDHomeRun TUNER EMULATION — makes Masqueradarr discoverable/addable as a Live TV source by anything that
// speaks the SiliconDust HDHomeRun HTTP API (Plex "Live TV & DVR", Emby, Jellyfin, Channels DVR). This is
// the INVERSE of adapters/hdhomerun/ (which lets Masqueradarr pull FROM a real HDHomeRun tuner on the LAN);
// this exposes Masqueradarr's own composed channel set AS one, in two scopes:
//   /hdhr/:slug/...                    the Global union (channelsForUser) — original behavior.
//   /hdhr/:slug/custom/:customId/...   ONE Custom playlist's channels (channelsForUserCustom), e.g. the
//                                       "Satellite" playlist — added because Global-only left any operator
//                                       whose channels live entirely under a Custom playlist with a tuner
//                                       that reports 0 channels (Global empty), even though their Custom
//                                       .m3u/EPG export works fine. :customId is the Playlist.id, not its
//                                       display name (visible in the playlist's own "HOSTED AT" URL/admin UI).
//
// Auth model mirrors the existing token-free-download / token-gated-stream split used by the per-user Global
// .m3u files (m3u/compose.ts writeUserGlobalFile): Plex/Emby can't do interactive login, so each user gets a
// stable, unguessable URL keyed by their existing `slug` (the same bearer secret the Global M3U filename
// already uses) — no new secret, no new auth plumbing. The lineup URLs it returns carry that user's
// streamToken exactly like the M3U export, so playback still goes through the normal streamGate. The Custom
// routes add a SECOND gate on top (channelsForUserCustom's admin || allowedCustomPlaylists check) — same
// membership rule the Custom .m3u export already enforces, just re-checked here since this router sits
// outside `authenticate` entirely (slug-in-path is the only auth).
//
// Mounted at root (NOT under /api — see index.ts), so it sits outside the `authenticate` middleware
// entirely; the slug in the path IS the auth.
//
// NOT implemented: SSDP/UPnP auto-discovery (multicast M-SEARCH response + /device.xml being found
// automatically on the LAN). Plex's "Live TV & DVR" setup also accepts a manual IP:port entry, which is
// enough to add this — point it at <domain>/hdhr/<slug> (Global) or <domain>/hdhr/<slug>/custom/<customId>
// (one Custom playlist). A real SSDP responder needs a long-lived UDP multicast listener process, which
// doesn't fit this request-per-HTTP-call Express router; if you want zero-config discovery later, that's a
// separate always-on service, not a route.

export const hdhomerunEmulationRouter = Router();

const TUNER_COUNT = 6; // advertised concurrency hint only — Masqueradarr has no real per-tuner cap

async function userBySlug(slug: string) {
  const user = await User.findOne({ slug });
  if (!user || !user.streamTokenEnabled) return null;
  return user;
}

// Stable 8-hex-char DeviceID derived from the scope key (slug, or slug+customId) — HDHomeRun clients expect
// a fixed device identity across requests; deriving it (rather than randomizing per-request) keeps Plex
// from thinking a new device appeared every time it polls. Global and each Custom playlist get DISTINCT
// device identities (different scopeKey) so Plex treats them as separate tuners, not one flapping device.
function deviceIdFor(scopeKey: string): string {
  return createHash('sha1').update(`masqueradarr-hdhr:${scopeKey}`).digest('hex').slice(0, 8);
}

// Shared GuideNumber/GuideName/URL row-builder for both scopes. GuideNumber must equal composeGuide's
// XMLTV <channel id> (= tvg_id), not channelNo — Plex matches HDHR lineup entries to guide data by this
// value, so a mismatch here is why "channel mappings" fail even though discover.json/lineup.json succeed.
// Falls back to channelNo/auto only when a channel is unlinked from EPG.
function buildLineup(
  channels: PlaylistChannelDoc[],
  domain: string,
  token?: string,
): Array<{ GuideNumber: string; GuideName: string; URL: string }> {
  const lineup: Array<{ GuideNumber: string; GuideName: string; URL: string }> = [];
  let auto = 1;
  for (const ch of channels) {
    const url = channelPlayUrl(ch, domain, token);
    if (!url) continue;
    lineup.push({
      GuideNumber: ch.tvg_id ?? ch.channelNo ?? String(auto),
      GuideName: ch.tvg_name,
      URL: url,
    });
    auto++;
  }
  return lineup;
}

function deviceXml(base: string, deviceId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${base}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>Masqueradarr</friendlyName>
    <manufacturer>Silicondust</manufacturer>
    <modelName>HDTC-2US</modelName>
    <modelNumber>HDTC-2US</modelNumber>
    <serialNumber>${deviceId}</serialNumber>
    <UDN>uuid:${deviceId}</UDN>
  </device>
</root>`;
}

// ---------------------------------------------------------------------------
// Global scope: /hdhr/:slug/...
// ---------------------------------------------------------------------------

hdhomerunEmulationRouter.get('/hdhr/:slug/discover.json', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const domain = await resolveDomain();
  const base = `${domain}/hdhr/${user.slug}`;
  res.json({
    FriendlyName: 'Masqueradarr',
    ModelNumber: 'HDTC-2US',
    FirmwareName: 'hdhomeruntc_atsc',
    FirmwareVersion: '20200101',
    DeviceID: deviceIdFor(user.slug),
    DeviceAuth: '',
    BaseURL: base,
    LineupURL: `${base}/lineup.json`,
    TunerCount: TUNER_COUNT,
  });
});

hdhomerunEmulationRouter.get('/hdhr/:slug/lineup_status.json', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not_found' });
  // Static lineup (no real over-the-air scan): always report "done", nothing in progress.
  res.json({ ScanInProgress: 0, ScanPossible: 0, Source: 'Cable', SourceList: ['Cable'] });
});

hdhomerunEmulationRouter.post('/hdhr/:slug/lineup.post', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).end();
  // No real tuner to scan — the lineup is just this user's live channel set. Accept scan=start/abort as a
  // no-op success so Plex's "Refresh Channels" doesn't error out.
  res.status(200).end();
});

hdhomerunEmulationRouter.get('/hdhr/:slug/lineup.json', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const domain = await resolveDomain();
  const channels = await channelsForUser(user);
  res.json(buildLineup(channels, domain, user.streamToken));
});

// UPnP root-device descriptor. Not auto-discovered (no SSDP responder — see the file header note), but some
// clients fetch this after a manual add to confirm the device before trusting discover.json.
hdhomerunEmulationRouter.get('/hdhr/:slug/device.xml', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).end();
  const domain = await resolveDomain();
  const base = `${domain}/hdhr/${user.slug}`;
  res.type('application/xml').send(deviceXml(base, deviceIdFor(user.slug)));
});

// ---------------------------------------------------------------------------
// Custom-playlist scope: /hdhr/:slug/custom/:customId/...
// Mirrors the Global routes above, but scoped to ONE Custom playlist via channelsForUserCustom. A missing
// or wrong :customId (no such Custom playlist) 404s the same as a bad slug; a real Custom playlist the user
// isn't permitted to see returns an EMPTY lineup (channelsForUserCustom's own gate), not a 404 — matches how
// the Custom .m3u export behaves for the same case (no leaking whether the id exists to an unpermitted user
// beyond what discover.json already reveals structurally).
// ---------------------------------------------------------------------------

hdhomerunEmulationRouter.get('/hdhr/:slug/custom/:customId/discover.json', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const resolved = await channelsForUserCustom(user, req.params.customId);
  if (!resolved) return res.status(404).json({ error: 'not_found' });
  const domain = await resolveDomain();
  const base = `${domain}/hdhr/${user.slug}/custom/${req.params.customId}`;
  res.json({
    FriendlyName: 'Masqueradarr',
    ModelNumber: 'HDTC-2US',
    FirmwareName: 'hdhomeruntc_atsc',
    FirmwareVersion: '20200101',
    DeviceID: deviceIdFor(`${user.slug}:${req.params.customId}`),
    DeviceAuth: '',
    BaseURL: base,
    LineupURL: `${base}/lineup.json`,
    TunerCount: TUNER_COUNT,
  });
});

hdhomerunEmulationRouter.get('/hdhr/:slug/custom/:customId/lineup_status.json', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const resolved = await channelsForUserCustom(user, req.params.customId);
  if (!resolved) return res.status(404).json({ error: 'not_found' });
  res.json({ ScanInProgress: 0, ScanPossible: 0, Source: 'Cable', SourceList: ['Cable'] });
});

hdhomerunEmulationRouter.post('/hdhr/:slug/custom/:customId/lineup.post', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).end();
  const resolved = await channelsForUserCustom(user, req.params.customId);
  if (!resolved) return res.status(404).end();
  res.status(200).end();
});

hdhomerunEmulationRouter.get('/hdhr/:slug/custom/:customId/lineup.json', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).json({ error: 'not_found' });
  const resolved = await channelsForUserCustom(user, req.params.customId);
  if (!resolved) return res.status(404).json({ error: 'not_found' });
  const domain = await resolveDomain();
  res.json(buildLineup(resolved.channels, domain, user.streamToken));
});

hdhomerunEmulationRouter.get('/hdhr/:slug/custom/:customId/device.xml', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).end();
  const resolved = await channelsForUserCustom(user, req.params.customId);
  if (!resolved) return res.status(404).end();
  const domain = await resolveDomain();
  const base = `${domain}/hdhr/${user.slug}/custom/${req.params.customId}`;
  res.type('application/xml').send(deviceXml(base, deviceIdFor(`${user.slug}:${req.params.customId}`)));
});
