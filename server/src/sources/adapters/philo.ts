// philo adapter — Philo via the operator's own philo-proxy instance (a companion service that solves Philo's
// auth + DRM via x11grab screen capture and republishes each channel as a plain HLS stream:
// https://github.com/n3o2345/philo-proxy). Unlike the public FAST/CDN adapters (pluto, xumo, …), philo-proxy
// has no fixed public domain — it's the operator's own LAN/compose service, addressed via PHILO_PROXY_URL
// (default assumes a `philo-proxy` compose service on its default port 5050; override for a different
// host/port). masqueradarr talks to it like any other trusted upstream: GET /api/channels for the catalog,
// GET /stream/:id/philo.m3u8 to play. NO auth handshake happens on this side — philo-proxy holds the real
// Philo session internally and serves both endpoints unauthenticated on its own network (see its routes/
// channels.js + routes/stream.js) — so requiresAuth is NOT set here.
//
// Each channel's stream_url is already resolved and stable for as long as philo-proxy stays up, so this is a
// direct-HLS source (the `direct`/freelivesports posture): normalize() stores the real .m3u8 entry point,
// isEntryUrl is the standard composer test, and resolveStream is identity — nothing to mint per play. The
// proxy trusts ONLY the configured philo-proxy host (not "any http(s)" like `direct` — this is one known,
// operator-configured upstream, not an arbitrary user import).
//
// philo-proxy also serves its own XMLTV guide at /epg.xml (routes/export.js) — add it as a normal EPG source
// (Settings → EPG Sources → Add → URL, pointed at `${PHILO_PROXY_URL}/epg.xml`) and match channels in Channel
// Mapping. No adapter-side self-EPG wiring here (unlike pluto/tubi/freelivesports, whose guides ride the same
// catalog fetch) — philo-proxy's guide is a separate endpoint with its own refresh cadence.

import type { SourceAdapter, ArtifactType } from '../types.js';
import type { SourceChannelDoc } from '../../models/SourceChannel.js';

const SOURCE_ID = 'philo';
const PHILO_PROXY_URL = (process.env.PHILO_PROXY_URL || 'http://philo-proxy:5050').replace(/\/+$/, '');

// Shape of a row from philo-proxy's GET /api/channels (src/routes/channels.js → the sqlite `channels` table).
interface PhiloRow {
  id: number | string;
  name: string;
  logo_url: string | null;
  group_name: string | null;
  enabled: number | boolean;
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
    const url = `${PHILO_PROXY_URL}/api/channels?enabled=1`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as PhiloRow[];
      return { raw, meta: { endpoint: url, live: true, fetchedAt: new Date().toISOString() } };
    } catch (err) {
      return {
        raw: [],
        meta: { endpoint: url, live: false, reason: (err as Error).message, fetchedAt: new Date().toISOString() },
      };
    }
  },

  normalize(raw: PhiloRow, { ingestedAt }): SourceChannelDoc | null {
    if (raw == null || raw.id == null || !raw.name) return null;
    const id = String(raw.id);
    const group = raw.group_name || 'Philo';
    return {
      _id: `${SOURCE_ID}:${id}`,
      source: SOURCE_ID,
      sourceChannelId: id,
      name: raw.name,
      category: group,
      groupKey: group,
      groupLabel: group,
      logoUrl: raw.logo_url || null,
      // The real, already-playable master — philo-proxy resolves/transcodes Philo itself.
      streamEntryUrl: `${PHILO_PROXY_URL}/stream/${id}/philo.m3u8`,
      isPlayable: true,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      ingestedAt,
    };
  },

  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // Add Playlist "Built-In" summary. No self-built guide here (see the file header) — the operator adds
  // philo-proxy's /epg.xml as its own EPG source and matches channels manually, like dulo.
  builtinMeta: {
    globalPlaylist: true,
    clonePlaylist: true,
    syncSchedules: true,
    playlistBoundEpg: false,
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
        if (p.includes('/philo-seg/')) return 'segment'; // src/routes/stream.js: /:channelId/philo-seg/:segment
        if (p.endsWith('.m3u8')) return 'master';
        return 'other';
      } catch {
        return 'other';
      }
    },
  },
};

export default philoAdapter;
