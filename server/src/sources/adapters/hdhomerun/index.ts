// HDHomeRun stream adapter — a synthetic (proxy-only) source. Imported device channels carry
// origin:'hdhomerun' and live under each HDHomeRun import Playlist's id (adapters/hdhomerun/import.ts).
// The operator enters the device's LAN IP directly (Playlist.deviceUrl, normalized by lineup.ts
// normalizeDeviceBase) — this adapter does not do device auto-discovery, only manual-IP import/sync.
//
// Playback: RESTORED. The old ffmpeg TS→HLS remux (remux.ts) was removed in the video-engine teardown, but
// it was never actually necessary for HDHomeRun — the device already serves raw MPEG-TS
// (http://<device-ip>:5004/auto/v<channel>), which is exactly the media type the rebuilt Rust pipeline pipes
// natively (see the /api/ext/v1 raw-TS `outputFormat: "ts"` path, and how VLC/direct passthrough handle raw
// TS elsewhere in the pipeline). So this is an identity passthrough, same shape as the `direct` adapter's raw
// (non-.m3u8) branch — no transcode, just proxy the device's stream straight through.

import type { SourceAdapter, ArtifactType } from '../../types.js';

const hdhomerunAdapter: SourceAdapter = {
  id: 'hdhomerun',
  label: 'HDHomeRun',
  synthetic: true, // proxy-only — no shell row, omitted from the manifest

  // ── listings: inert. Channels are synced per-device by import.ts, not a generic catalog. ──
  async listChannels() {
    return { raw: [], meta: { live: false } };
  },
  normalize() {
    return null;
  },

  // Never surfaced (synthetic → omitted from the manifest), but the contract requires it.
  grouping: { by: 'groupKey', groupOrder: 'alpha', channelOrder: 'name' },

  // ── stream resolution: identity — the stored device URL IS the playable raw-TS master. ──
  isEntryUrl() {
    return true; // every stored device-TS URL is treated as a channel entry (per-play viewer telemetry)
  },
  async resolveStream(entryUrl: string): Promise<{ masterUrl: string }> {
    return { masterUrl: entryUrl };
  },

  // ── proxy behavior: permissive-but-SSRF-safe passthrough, same posture as `direct` (LAN sources). ──
  proxy: {
    upstreamHeaders() {
      return {}; // the device needs no auth handshake
    },
    isAllowedUpstream(url: string) {
      // Allow ANY http(s) host, INCLUDING private/loopback/link-local literals — an HDHomeRun tuner is
      // always a LAN device (the operator enters its IP directly; see lineup.ts normalizeDeviceBase), so
      // the proxy must be able to reach 192.168.x.x/10.x.x.x addresses. Protocol is the only real gate,
      // same as direct.ts.
      try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },
    allowPrivate: true, // the actual private-IP gate — a tuner is always a LAN device (isAllowedUpstream above only checks protocol)
    onPlaylistChildHost: null, // raw MPEG-TS has no manifest children to learn
    relabelSegmentContentType(_url: string, contentType: string) {
      return contentType || 'video/mp2t';
    },
    classifyArtifact(url: string): ArtifactType {
      try {
        const p = new URL(url).pathname.toLowerCase();
        if (/\.ts$/.test(p)) return 'segment';
        if (p.endsWith('.m3u8')) return 'variant';
        return 'other';
      } catch {
        return 'other';
      }
    },
  },
};

export default hdhomerunAdapter;
