// philo adapter — Philo via the operator's own philo-proxy instance (a companion service that solves Philo's
// auth + DRM via x11grab screen capture and republishes each channel as a plain HLS stream:
// https://github.com/n3o2345/philo-proxy). Unlike the public FAST/CDN adapters (pluto, xumo, …), philo-proxy
// has no fixed public domain — it's the operator's own LAN/compose service, addressed via PHILO_PROXY_URL
// (default assumes a `philo-proxy` compose service on its default port 5050; override for a different
// host/port). masqueradarr talks to it like any other trusted upstream: GET /channels.m3u for the catalog
// (an EXTM3U playlist — tvg-id/tvg-logo/group-title/the real per-channel .m3u8 URL, one line per channel),
// GET /epg.xml for its own XMLTV guide. NO auth handshake happens on this side — philo-proxy holds the real
// Philo session internally and serves both endpoints unauthenticated on its own network — so requiresAuth is
// NOT set here.
//
// CHANGED (2026-07): catalog + guide now come from philo-proxy's own EXTM3U + XMLTV exports (like every other
// self-hosted or public source), not its old /api/channels JSON row shape — same upstream service, just its
// published-playlist surface instead of its internal DB rows. This makes Philo a PLAYLIST-BOUND-EPG source
// like pluto/tubi/freelivesports (afterSync builds the self-EPG + self-links untouched channels), instead of
// requiring the operator to manually add philo-proxy's /epg.xml as its own EPG source and hand-match channels
// (the old dulo-style posture).
//
// Each channel's stream URL comes straight from channels.m3u (already resolved/stable for as long as
// philo-proxy stays up), so this is a direct-HLS source (the `direct`/freelivesports posture): normalize()
// stores the real .m3u8 entry point verbatim, isEntryUrl is the standard composer test, and resolveStream is
// identity — nothing to mint per play. The proxy trusts ONLY the configured philo-proxy host (not "any
// http(s)" like `direct` — this is one known, operator-configured upstream, not an arbitrary user import).

import { parseM3u } from '../../m3u/parse.js';
import { EpgChannel } from '../../models/EpgChannel.js';
import { syncXmltvUrl } from '../../epg/xmltvIngest.js';
import { linkFastSelfEpg, upsertFastEpgSource } from '../../epg/fastSelfEpg.js';
import { resolveProgramOffset } from '../../settings/programOffset.js';
import { logger } from '../core/logger.js';
import type { SourceAdapter, ArtifactType } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'philo';
const PHILO_PROXY_URL = (process.env.PHILO_PROXY_URL || 'http://philo-proxy:5050').replace(/\/+$/, '');
const PLAYLIST_URL = `${PHILO_PROXY_URL}/channels.m3u`;
const EPG_URL = `${PHILO_PROXY_URL}/epg.xml`;
const PHILO_EPG_NAME = 'Philo Guide';

// One parsed EXTM3U row → the shape normalize() needs. Kept minimal — parseM3u already did the attribute
// extraction; this just carries it through listChannels' { raw, meta } contract like every other adapter.
interface PhiloRow {
  id: string; // tvg-id — also the id philo-proxy's epg.xml uses for <channel id="…">, so the two line up
  name: string;
  logo: string | null;
  group: string | null;
  url: string; // the real, already-playable .m3u8 (or other) stream URL
}

// Cached once — PHILO_PROXY_URL is fixed for the process lifetime (an env var, not a per-request value).
let allowedHost = '';
try {
  allowedHost = new URL(PHILO_PROXY_URL).hostname.toLowerCase();
} catch {
  /* malformed PHILO_PROXY_URL — isAllowedUpstream below simply denies everything */
}

const philoAdapter: SourceAdapter = {
  id: SOURCE_ID,
  label: 'Philo',

  // Catalog fetch has no offline snapshot: philo-proxy is a single self-hosted instance with no public
  // fallback to bundle — an unreachable box just yields an empty, warn-flagged sync (buildSource.ts) rather
  // than a stale committed catalog.
  async listChannels() {
    try {
      const res = await fetch(PLAYLIST_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const { entries } = parseM3u(text);
      const raw: PhiloRow[] = entries
        .filter((e) => e.tvgId) // an entry with no tvg-id can't be linked to the epg.xml guide or re-synced idempotently
        .map((e) => ({ id: e.tvgId as string, name: e.name, logo: e.tvgLogo, group: e.groupTitle, url: e.url }));
      return { raw, meta: { endpoint: PLAYLIST_URL, live: true, count: raw.length, fetchedAt: new Date().toISOString() } };
    } catch (err) {
      return {
        raw: [],
        meta: { endpoint: PLAYLIST_URL, live: false, reason: (err as Error).message, fetchedAt: new Date().toISOString() },
      };
    }
  },

  normalize(raw: PhiloRow, { ingestedAt }): SourceChannelDoc | null {
    if (raw == null || !raw.id || !raw.name || !raw.url) return null;
    const group = raw.group || 'Philo';
    return {
      _id: `${SOURCE_ID}:${raw.id}`,
      source: SOURCE_ID,
      sourceChannelId: raw.id,
      name: raw.name,
      category: group,
      groupKey: group,
      groupLabel: group,
      logoUrl: raw.logo || null,
      // The real, already-playable master straight from channels.m3u — philo-proxy resolves/transcodes
      // Philo itself, so there's nothing left to construct here.
      streamEntryUrl: raw.url,
      isPlayable: true,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      ingestedAt,
    };
  },

  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. philo-proxy publishes its own XMLTV guide (epg.xml) keyed by the SAME
  // channel ids as channels.m3u's tvg-id, so afterSync below builds a real self-EPG (like pluto/tubi) →
  // Playlist-bound EPG is true; the operator no longer adds/matches it by hand.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    playlistBoundEpg: true,
    epgSyncSchedules: false,
  },

  status: () => ({ proxyUrl: PHILO_PROXY_URL }),

  // Standard composer test — the stored entry IS the master .m3u8, resolved per play only for viewer
  // telemetry (like `direct`), never rewritten.
  isEntryUrl(url: string) {
    try {
      return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
    } catch {
      return false;
    }
  },
  async resolveStream(entryUrl: string) {
    return { masterUrl: entryUrl }; // identity — philo-proxy already resolved the real Philo stream
  },

  proxy: {
    upstreamHeaders() {
      return {}; // a LAN/compose hop to our own trusted proxy — no handshake needed
    },
    isAllowedUpstream(url: string) {
      try {
        const u = new URL(url);
        return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.toLowerCase() === allowedHost;
      } catch {
        return false;
      }
    },
    allowPrivate: true, // the actual private-IP gate — philo-proxy is the operator's own LAN/compose box
    onPlaylistChildHost: null, // philo-proxy serves segments from the same configured host — nothing to learn
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'video/mp2t';
    },
    classifyArtifact(url: string): ArtifactType {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (p.includes('-seg') || p.includes('/seg/') || p.includes('segment')) return 'segment';
        if (p.endsWith('.m3u8')) return 'master';
        return 'other';
      } catch {
        return 'other';
      }
    },
  },

  // ── post-sync: build the philo-proxy self-EPG from its own epg.xml, then self-link untouched channels ──
  // Live-only (a snapshot never exists for Philo — see listChannels — so `live` is effectively always true
  // on a reachable box; guarded anyway for symmetry with the FAST family). Non-fatal: logged and swallowed,
  // never fails the channel sync.
  async afterSync({ sourceId, live }) {
    if (!live) return;
    try {
      const { offset, defaulted } = await resolveProgramOffset();
      if (defaulted) logger.warn('seed', `[${sourceId}] settings offset unset — guide times stored as UTC (+0000)`);
      // Streams + REPLACES this source's epgchannels/programs straight from philo-proxy's XMLTV (bounded
      // memory; same path a remote-url EPG source uses). buildEpgChannel/buildProgram already stamp the
      // "<sourceId>:<id>" composite keys, so this lines up 1:1 with writeFastEpg's convention.
      const counts = await syncXmltvUrl(sourceId, EPG_URL, offset);
      const channelIds = await EpgChannel.find({ source: sourceId }).distinct('channelId');
      await upsertFastEpgSource(sourceId, counts, { name: PHILO_EPG_NAME, url: EPG_URL });
      const linked = await linkFastSelfEpg(sourceId, channelIds);
      logger.info(
        'seed',
        `[${sourceId}] self-EPG: ${counts.channels} channels / ${counts.programs} programs; linked ${linked} untouched channel(s)`,
      );
    } catch (err) {
      logger.warn('seed', `[${sourceId}] self-EPG (epg.xml) failed (continuing): ${(err as Error).message}`);
    }
  },
};

export default philoAdapter;
