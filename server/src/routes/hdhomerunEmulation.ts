import { Router } from 'express';
import { createHash } from 'node:crypto';
import { User } from '../models/User.js';
import { channelsForUser, resolveDomain } from '../m3u/compose.js';
import { channelPlayUrl } from '../m3u/serialize.js';

// HDHomeRun TUNER EMULATION — makes Masqueradarr discoverable/addable as a Live TV source by anything that
// speaks the SiliconDust HDHomeRun HTTP API (Plex "Live TV & DVR", Emby, Jellyfin, Channels DVR). This is
// the INVERSE of adapters/hdhomerun/ (which lets Masqueradarr pull FROM a real HDHomeRun tuner on the LAN);
// this exposes Masqueradarr's own composed channel set (every source, not just imported HDHomeRun devices)
// AS one.
//
// Auth model mirrors the existing token-free-download / token-gated-stream split used by the per-user Global
// .m3u files (m3u/compose.ts writeUserGlobalFile): Plex/Emby can't do interactive login, so each user gets a
// stable, unguessable URL keyed by their existing `slug` (the same bearer secret the Global M3U filename
// already uses) — no new secret, no new auth plumbing. The lineup URLs it returns carry that user's
// streamToken exactly like the M3U export, so playback still goes through the normal streamGate.
//
// Mounted at root (NOT under /api — see index.ts), so it sits outside the `authenticate` middleware
// entirely; the slug in the path IS the auth.
//
// NOT implemented: SSDP/UPnP auto-discovery (multicast M-SEARCH response + /device.xml being found
// automatically on the LAN). Plex's "Live TV & DVR" setup also accepts a manual IP:port entry, which is
// enough to add this — point it at <domain>/hdhr/<slug>. A real SSDP responder needs a long-lived UDP
// multicast listener process, which doesn't fit this request-per-HTTP-call Express router; if you want
// zero-config discovery later, that's a separate always-on service, not a route.

export const hdhomerunEmulationRouter = Router();

const TUNER_COUNT = 6; // advertised concurrency hint only — Masqueradarr has no real per-tuner cap

async function userBySlug(slug: string) {
  const user = await User.findOne({ slug });
  if (!user || !user.streamTokenEnabled) return null;
  return user;
}

// Stable 8-hex-char DeviceID derived from the user's slug — HDHomeRun clients expect a fixed device
// identity across requests; deriving it (rather than randomizing per-request) keeps Plex from thinking a
// new device appeared every time it polls.
function deviceIdFor(slug: string): string {
  return createHash('sha1').update(`masqueradarr-hdhr:${slug}`).digest('hex').slice(0, 8);
}

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
  const lineup: Array<{ GuideNumber: string; GuideName: string; URL: string }> = [];
  let auto = 1;
  for (const ch of channels) {
    const url = channelPlayUrl(ch, domain, user.streamToken);
    if (!url) continue;
    lineup.push({
      GuideNumber: ch.channelNo ?? String(auto),
      GuideName: ch.tvg_name,
      URL: url,
    });
    auto++;
  }
  res.json(lineup);
});

// UPnP root-device descriptor. Not auto-discovered (no SSDP responder — see the file header note), but some
// clients fetch this after a manual add to confirm the device before trusting discover.json.
hdhomerunEmulationRouter.get('/hdhr/:slug/device.xml', async (req, res) => {
  const user = await userBySlug(req.params.slug);
  if (!user) return res.status(404).end();
  const domain = await resolveDomain();
  const base = `${domain}/hdhr/${user.slug}`;
  const deviceId = deviceIdFor(user.slug);
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
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
</root>`,
  );
});
