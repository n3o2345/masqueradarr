import type { Response, NextFunction } from 'express';
import type { AuthRequest } from './auth.js';
import { PlaylistChannel } from '../models/PlaylistChannel.js';
import { SOURCES } from '../sources/registry.js';

// The per-request stream-token gate — rebuilt from the ladder the video-engine teardown removed (users.md §5).
// Applied to the reverse-proxied /api/v1 (appPlayer) + /api/ext/v1 (externalPlayer) stream mounts, AFTER the
// global `authenticate` (which populates req.user from EITHER a session token or a streamToken; the in-app
// player also streams with ?token=<streamToken>, so the ladder applies uniformly). Errors are PLAIN TEXT — the
// HLS-proxy deviation from the JSON resource API, so a media player surfaces the message.
//
// `:source` is the PROVIDER source (the path segment after /v1/) the proxy resolves against — dulo/dlhd/…,
// never a clone id (a clone channel's proxy URL keys on its `origin` provider). Step 3 is intentionally
// `allowedPlaylists`-only (NOT unioned with allowedCustomPlaylists) — see users.md §5.
//
// SYNTHETIC-SOURCE EXCEPTION (added after a real deployment bug): synthetic (proxy-only) sources — hdhomerun,
// local, direct — are deliberately OMITTED from the Global provider manifest (sources/registry.ts: "the
// manifest omits it so it never appears in the Add Playlist Built-In list"). That means a non-admin user has
// NO UI path to ever add one of these to allowedPlaylists — the Step-3 check below is unconditionally
// unsatisfiable for them, regardless of what's granted anywhere. Confirmed in practice: a user with a Custom
// playlist explicitly granting them a cloned HDHomeRun/Local-Now channel still got a flat 403 streaming it,
// while an admin (exempt from Step 3 entirely) streamed the identical channel fine. For these three sources
// only, `streamGate` now falls back to checking the actual channel's owning Custom playlist
// (allowedCustomPlaylists) before denying — the same permission the "Assign access" UI actually manages for
// these sources. Every other (real catalog) source keeps the original allowedPlaylists-only rule unchanged.

export interface GateDecision {
  ok: boolean;
  /** HTTP status + plain-text message to surface on a deny (set only when ok=false). */
  status?: number;
  message?: string;
}

export const SYNTHETIC_SOURCES = new Set(SOURCES.filter((s) => s.synthetic).map((s) => s.id));

/**
 * The stream-access ladder as a pure function of (user, source), shared by:
 *  · this `streamGate` Express middleware (the sidecar topology, in front of `proxyRelay`), and
 *  · the resolve-seam authorize step (`POST /api/internal/authorize`) — the gate Rust's per-request auth
 *    cache calls once Rust is the public edge (EDGE-3), where no Express middleware sits in front of streams.
 * The token gate ALWAYS lives in Node, where `req.user`/`allowedPlaylists` live, in every topology.
 *
 * Deliberately UNCHANGED (still synchronous, still allowedPlaylists-only) — the synthetic-source Custom-
 * playlist fallback lives only in the `streamGate` Express middleware below, not here, so this function's
 * other caller (the internal authorize endpoint) is completely unaffected by it.
 */
export function gateStreamAccess(user: AuthRequest['user'], source: string): GateDecision {
  if (!user) {
    return { ok: false, status: 401, message: 'Unauthorized: stream token required' };
  }
  if (!user.streamTokenEnabled) {
    return { ok: false, status: 403, message: 'Forbidden: stream token is disabled' };
  }
  if (user.role === 'user' && !(user.allowedPlaylists ?? []).includes(source)) {
    return { ok: false, status: 403, message: 'Forbidden: you do not have access to this source' };
  }
  return { ok: true };
}

export async function streamGate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // req.path is the remainder AFTER the matched mount (/api/v1 or /api/ext/v1) → "/<source>/<rest>".
  const segments = req.path.split('/').filter(Boolean);
  const source = segments[0] ?? '';
  const decision = gateStreamAccess(req.user, source);
  if (decision.ok) {
    next();
    return;
  }

  // Synthetic-source fallback — see file header. Only reachable on an otherwise-403 (not a missing-user 401,
  // and not a streamTokenEnabled 403) for one of the three proxy-only sources.
  if (decision.status === 403 && req.user && SYNTHETIC_SOURCES.has(source)) {
    const entrySegment = segments[1];
    const entryUrl = entrySegment ? decodeURIComponent(entrySegment) : '';
    if (entryUrl) {
      // Multiple clones of the same provider channel can exist across different Custom playlists — grant if
      // the user has access to ANY of the playlists this exact (origin, streamEntryUrl) pair lives under.
      const candidates = await PlaylistChannel.find(
        { origin: source, streamEntryUrl: entryUrl, status: 'Active' },
        { source: 1 },
      ).lean();
      const allowedCustom = req.user.allowedCustomPlaylists ?? [];
      const permitted = req.user.role === 'admin' || candidates.some((c) => allowedCustom.includes(c.source));
      if (permitted) {
        next();
        return;
      }
    }
  }

  res.status(decision.status!).type('text/plain').send(decision.message!);
}
