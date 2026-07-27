import type { PlaylistChannelDoc } from '../models/PlaylistChannel.js';

// Pure EXTM3U serialization — the Channel → #EXTINF field mapping, with NO DB or fs access (so it stays
// trivially testable). LF discipline + the trailing newline are the caller's concern (compose.ts joins
// entries with '\n'). See .claude/skills/m3u/SKILL.md §1–§4 for the wire format and field rules.

// Strip characters that would corrupt an EXTINF line (embedded double-quotes / CR / LF). Source data
// almost never contains these; this keeps one bad value from breaking the whole playlist.
function clean(v: string): string {
  return v.replace(/[\r\n"]/g, '');
}

/** The playlist header line. `guideUrl` adds x-tvg-url= when an EPG guide is configured (deferred today → null). */
export function m3uHeader(guideUrl: string | null): string {
  return guideUrl ? `#EXTM3U x-tvg-url="${clean(guideUrl)}"` : '#EXTM3U';
}

// The derived proxy URL for a channel (§4), used both as the second line of channelToExtinf's entry and by
// any URL-only consumer (e.g. HDHomeRun lineup emulation, routes/hdhomerunEmulation.ts, which needs a bare
// playable URL with no EXTINF wrapper). Same gating as channelToExtinf: null unless Active, non-failover-
// child, with a stream entry and a resolvable source.
export function channelPlayUrl(ch: PlaylistChannelDoc, domain: string, token?: string): string | null {
  if (ch.status !== 'Active' || ch.failoverRole === 'child') return null;
  // The proxy source is the channel's PROVIDER: for a clone copy that's `origin` (the real adapter, e.g.
  // "dulo") since its `source` is the clone id; for a source-playlist channel `origin` is null → use `source`.
  const streamSource = ch.origin ?? ch.source;
  if (!ch.streamEntryUrl || !streamSource) return null;
  const base = domain.replace(/\/+$/, '');
  let url = `${base}/api/ext/v1/${streamSource}/${encodeURIComponent(ch.streamEntryUrl)}`;
  if (token) {
    url += `?token=${encodeURIComponent(token)}`;
  }
  // §4b per-playlist videoconfig selector — see channelToExtinf below for the full rationale.
  url += `${url.includes('?') ? '&' : '?'}pl=${encodeURIComponent(ch.source)}`;
  return url;
}

// One channel → its 2-line "#EXTINF:-1 …,<name>\n<url>" entry, or null when the channel can't be composed
// (not Active, or no stream entry). `domain` is the absolute origin used to build the derived proxy URL.
export function channelToExtinf(ch: PlaylistChannelDoc, domain: string, token?: string): string | null {
  // §5 inclusion governor — only Active, non-failover-child channels (callers already filter; this is
  // defensive). A failover child is a hidden backup served through its parent's line — never exported.
  // Undefined-safe: pre-feature docs lack failoverRole entirely.
  //
  // §4 URL line — DERIVED, never stored. This M3U is consumed by EXTERNAL IPTV clients (TiviMate/Kodi/VLC/…).
  // It targets the externalPlayer mount /api/ext/v1, which was REMOVED in the video-engine teardown — so these
  // exported URLs do NOT resolve until a new playback engine is rebuilt (a deliberate "leave dead until rebuild"
  // choice; the derivation is kept intact so the export files still generate with stable, rebuild-ready URLs).
  // For dulo, streamEntryUrl is the `dulo://channel/<id>` sentinel; the proxy mints the real playbackUrl
  // per play, so the m3u references the proxy path, never a resolved (expiring) upstream.
  const url = channelPlayUrl(ch, domain, token);
  if (!url) return null;

  // §3 attribute mapping — order matches the SKILL §13 worked example. Each optional attr is OMITTED
  // (never fabricated) when its source field is null.
  const attrs: string[] = [];
  // tvg-id ONLY when a real 2-factor EPG link exists (tvg_id present AND epg set) — never bind a phantom guide.
  if (ch.tvg_id != null && ch.epg != null) attrs.push(`tvg-id="${clean(ch.tvg_id)}"`);
  attrs.push(`tvg-name="${clean(ch.tvg_name)}"`); // drives both the attr and the trailing display name
  if (ch.channelNo != null) attrs.push(`tvg-chno="${clean(ch.channelNo)}"`);
  if (ch.logoUrl != null) attrs.push(`tvg-logo="${clean(ch.logoUrl)}"`);
  if (ch.group != null) attrs.push(`group-title="${clean(ch.group)}"`);

  return `#EXTINF:-1 ${attrs.join(' ')},${clean(ch.tvg_name)}\n${url}`;
}
