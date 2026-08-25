<script setup lang="ts">
// A self-contained rolling live TV-guide grid (scrolling timeline + list view, live-now highlighting,
// fetch-on-scroll), driven purely by a `channels` prop rather than an EPG source id. Generalized out of
// EPGDetailScreen.vue's guide rendering (see that file for the sibling, EPG-source-scoped usage) so a
// second screen — PlaylistDetailScreen's Guide tab — can show the same kind of grid for an arbitrary
// channel list without duplicating the timeline/virtual-scroll math by hand.
//
// Deliberately self-contained: search/status-filter/viewing-program state all live HERE, not lifted to the
// parent, so a consuming screen just drops in `<EpgGuideGrid :channels="..." />` and gets a fully working
// guide — same as an <iframe> in spirit, minus the parent needing to know anything about programs, EPG
// link-keys, or scroll/virtualization mechanics.
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import Icon from './Icon.vue';
import Btn from './Btn.vue';
import Pill from './Pill.vue';
import SearchInput from './SearchInput.vue';
import ChannelLogo from './ChannelLogo.vue';
import Segmented from './Segmented.vue';
import { EPG_PROGRAMS, fetchProgramsFor, type Channel, type Program } from '../data';
import { useTweaks } from '../composables/useTweaks';
import { useVirtualList } from '../composables/useVirtualList';

const props = defineProps<{ channels: Channel[] }>();
const { tweaks } = useTweaks();

// Status filter for the guide (Active vs Disabled), mirroring PlaylistDetailScreen/EPGDetailScreen.
const statusFilter = ref<'Active' | 'Disabled'>('Active');
const activeCount = computed(() => props.channels.filter((c) => c.status === 'Active').length);
const disabledCount = computed(() => props.channels.filter((c) => c.status === 'Disabled').length);
// Free-text channel search (case-insensitive substring over tvg_name + tvg_id + group), ANDed with the
// status toggle. Debounced via the shared SearchInput so a large channel set stays responsive.
const search = ref('');
const filteredChannels = computed(() => {
  const q = search.value.trim().toLowerCase();
  return props.channels.filter((c) => {
    if (c.status !== statusFilter.value) return false;
    if (!q) return true;
    return [c.tvg_name, c.tvg_id, c.group].some((v) => (v || '').toLowerCase().includes(q));
  });
});

// Real wall-clock in epoch-ms — programs are stored epoch-ms, so the whole timeline runs off one uniform
// time model. Ticked each minute to advance the now-line.
const HOUR_MS = 3_600_000;
const now = ref(Date.now());
function tick() { now.value = Date.now(); }
let tickId: number | null = null;
onMounted(() => {
  tick();
  tickId = window.setInterval(tick, 60000);
});
onBeforeUnmount(() => { if (tickId) clearInterval(tickId); });

// The timeline is a ROLLING window anchored at "now" (not the calendar day): LEAD_HOURS of recent past at
// the left, then the rest forward. Anchored to the top of the current local hour so axis ticks land on
// clean HH:00 and the now-line tracks across them.
const WINDOW_HOURS = 24; // initial visible span — grows as the user scrolls forward (continuous fetch-on-scroll)
const MAX_SPAN_HOURS = 24 * 7; // cap the extendable canvas at a week so it can't grow unbounded
const SPAN_STEP_HOURS = 24; // how much further the window extends each time the user nears the right edge
const LEAD_HOURS = 1; // recent past shown to the left of "now"
const spanHours = ref(WINDOW_HOURS);
const windowStart = computed(() => {
  const d = new Date(now.value);
  d.setMinutes(0, 0, 0); // top of the current local hour
  return d.getTime() - LEAD_HOURS * HOUR_MS;
});
const windowEnd = computed(() => windowStart.value + spanHours.value * HOUR_MS);
function dayHours(ms: number): number { return (ms - windowStart.value) / HOUR_MS; }
function clampDay(h: number): number { return Math.max(0, Math.min(spanHours.value, h)); }
function isLive(p: Program): boolean { return now.value >= p.start && now.value < p.end; }
const nowHHMM = computed(() => formatTime(now.value));

const viewing = ref<{ channel: Channel; prog: Program } | null>(null);
function open(channel: Channel, prog: Program) { viewing.value = { channel, prog }; }
function close() { viewing.value = null; }

function formatTime(ms: number) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function humanizeDur(ms: number) {
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}
function humanizeDelta(ms: number) {
  if (ms < HOUR_MS) return Math.round(ms / 60000) + ' min';
  return humanizeDur(ms);
}

const HOUR_W = 140;
const totalW = computed(() => spanHours.value * HOUR_W);
const axisLabels = computed(() =>
  Array.from({ length: spanHours.value }, (_, i) => formatTime(windowStart.value + i * HOUR_MS)),
);
function progLeft(p: Program): number { return clampDay(dayHours(p.start)) * HOUR_W + 2; }
function progWidth(p: Program): number {
  return Math.max(2, (clampDay(dayHours(p.end)) - clampDay(dayHours(p.start))) * HOUR_W - 4);
}
function nowLeft(): number { return clampDay(dayHours(now.value)) * HOUR_W; }

// ── Timeline horizontal scroll: keep the hour header in step with the body, and align "now" near the left ──
const bodyRef = ref<HTMLElement | null>(null);
const headInnerRef = ref<HTMLElement | null>(null);
function syncHeadScroll() {
  if (headInnerRef.value) headInnerRef.value.style.transform = `translateX(${-(bodyRef.value?.scrollLeft ?? 0)}px)`;
}
function centerOnNow() {
  const el = bodyRef.value;
  if (!el) return;
  el.scrollLeft = Math.max(0, nowLeft() - HOUR_W);
  syncHeadScroll();
}
async function recenterTimeline() {
  if (tweaks.epgMode !== 'timeline' || !props.channels.length) return;
  await nextTick();
  centerOnNow();
}
onMounted(recenterTimeline);
// Re-center when the channel set or mode changes. Deliberately NOT keyed on `now`, so the per-minute tick
// never yanks the user's scroll position.
watch(() => [tweaks.epgMode, props.channels.length], recenterTimeline);

// ── Vertical virtual windowing of the channel rows + lazy, scroll-driven program fetch ──────────────
const ROW_H = 76;
const vt = useVirtualList(bodyRef, () => filteredChannels.value.length, ROW_H);
const vStart = vt.start, vEnd = vt.end, vPad = vt.padTop, vTotal = vt.totalHeight;

function chKey(c: Channel): string | null {
  return c.epg && c.tvg_id ? `${c.epg}:${c.tvg_id}` : null;
}
function neededKeys(): string[] {
  const chans = tweaks.epgMode === 'timeline'
    ? filteredChannels.value.slice(vStart.value, vEnd.value)
    : filteredChannels.value;
  return chans.map(chKey).filter((k): k is string => !!k);
}
let lastFetchSig = '';
let fetchTimer: number | null = null;
function ensureProgramsLoaded(): void {
  const keys = neededKeys();
  if (!keys.length) return;
  const sig = windowEnd.value + '|' + keys.join(',');
  if (sig === lastFetchSig) return;
  lastFetchSig = sig;
  fetchProgramsFor(keys, windowStart.value, windowEnd.value)
    .catch((err) => console.error('[epg-guide-grid] programs load failed:', err));
}
function scheduleEnsure(): void {
  if (fetchTimer) clearTimeout(fetchTimer);
  fetchTimer = window.setTimeout(ensureProgramsLoaded, 150);
}

function maybeGrowSpan(): void {
  const el = bodyRef.value;
  if (!el || spanHours.value >= MAX_SPAN_HOURS) return;
  if (el.scrollLeft + el.clientWidth >= totalW.value - HOUR_W * 2) {
    spanHours.value = Math.min(MAX_SPAN_HOURS, spanHours.value + SPAN_STEP_HOURS);
  }
}
function onBodyScroll(): void {
  syncHeadScroll();
  vt.measure();
  maybeGrowSpan();
  scheduleEnsure();
}
watch(
  () => [tweaks.epgMode, filteredChannels.value.length, spanHours.value, windowEnd.value],
  () => nextTick(() => { vt.measure(); scheduleEnsure(); }),
  { immediate: true },
);
onBeforeUnmount(() => { if (fetchTimer) clearTimeout(fetchTimer); });

const dayLabel = computed(() =>
  'Today, ' +
  new Date(now.value).toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  }),
);

function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && viewing.value) close(); }
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function progState(p: Program) {
  if (now.value >= p.start && now.value < p.end) return 'live';
  if (now.value >= p.end) return 'past';
  return 'upcoming';
}

const blurbs: Record<string, string> = {
  'Live': "Live coverage with breaking updates, analysis and reports from correspondents on the ground.",
  'News': "The latest national and international stories, plus business, sport, and a look at tomorrow's papers.",
  'Documentary': "An in-depth feature on the world's most fascinating places, people, and events.",
  'Lifestyle': "Fresh ideas for home, food, and travel — practical inspiration for everyday living.",
  'Film': "A feature-length presentation. Cinematic storytelling with subtitles and audio description available.",
  'Football': "Full match coverage with pre-match build-up, expert punditry, and post-match analysis.",
  'Highlights': "The best moments and key plays condensed into a fast-paced roundup.",
  'Comedy': "An evening of stand-up, sketches, and satire from familiar faces and rising stars.",
  'Series': "The next instalment in our ongoing drama series. Contains scenes some viewers may find intense.",
  'Music': "Back-to-back hits, exclusive sessions, and the latest releases from across the charts.",
  'Kids': "Bright, friendly programming made just for younger viewers — learning through play.",
  'Technology': "What's new in tech, gadgets, and software — reviews, deep-dives, and hands-on demos.",
  'Discussion': "Panel conversation with guests dissecting the day's biggest stories.",
  'Business': "Markets, deals, and the people moving them. Plus analysis from the trading floor.",
  'Weather': "A full national outlook plus regional forecasts for the next 48 hours.",
  'Game show': "Quick-fire rounds and big prizes — armchair contestants welcome.",
  'Feature': "A standalone feature presentation tonight. Tune in for an unmissable story.",
};

function progs(c: Channel) {
  const k = chKey(c);
  return k ? (EPG_PROGRAMS[k] || []) : [];
}
function listProgs(c: Channel) {
  return progs(c).filter((p) => p.end >= now.value - HOUR_MS).slice(0, 6);
}
function livePr(c: Channel) {
  return listProgs(c).find((p) => isLive(p));
}
</script>

<template>
  <div class="card flush epg-grid-card" style="display: flex; flex-direction: column;">
    <div class="toolbar">
      <Pill tone="cyan">
        <Icon name="epg" :size="11" />
        {{ dayLabel }}
      </Pill>
      <SearchInput :value="search" @change="(v) => search = v" :debounce="200" placeholder="Filter channels" :width="220" />
      <Pill tone="system" :title="`${channels.length} channel(s)`">
        {{ channels.length }} channels
      </Pill>
      <div class="segmented" style="padding: 2px;">
        <button :class="['seg-cyan', statusFilter === 'Active' ? 'active' : '']" @click="statusFilter = 'Active'"
                style="font-size: 10.5px; padding: 3px 8px;">{{ activeCount }} Active</button>
        <button :class="['seg-amber', statusFilter === 'Disabled' ? 'active' : '']" @click="statusFilter = 'Disabled'"
                style="font-size: 10.5px; padding: 3px 8px;">{{ disabledCount }} Disabled</button>
      </div>
      <span class="spacer" />
      <span class="muted" style="font-size: var(--fs-xs);">
        Now: <span class="mono" style="color: var(--accent-hi);">{{ nowHHMM }}</span>
      </span>
      <Segmented :value="tweaks.epgMode" @change="() => {}" :options="[
        { value: 'timeline', label: 'Timeline', icon: 'grid' },
        { value: 'list', label: 'List', icon: 'list' },
      ]" />
    </div>

    <!-- Empty state -->
    <div v-if="!channels.length" class="muted" style="flex: 1; display: grid; place-items: center; text-align: center; padding: 40px;">
      <div>
        <Icon name="epg" :size="32" />
        <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">No channels yet</div>
        <div style="margin-top: 6px; font-size: var(--fs-sm);">This playlist has no channels to show a guide for.</div>
      </div>
    </div>

    <!-- Timeline -->
    <div v-else-if="tweaks.epgMode === 'timeline'" class="epg" style="flex: 1; overflow: hidden;">
      <div class="epg-head">
        <div class="head-l">Channel</div>
        <div ref="headInnerRef" class="head-r" :style="{ width: totalW + 'px' }">
          <div v-for="(label, i) in axisLabels" :key="i" class="epg-time" :style="{ width: HOUR_W + 'px' }">
            {{ label }}
          </div>
        </div>
      </div>
      <div ref="bodyRef" class="epg-body" @scroll="onBodyScroll">
        <div :style="{ width: (200 + totalW) + 'px', height: vTotal + 'px', position: 'relative' }">
          <div :style="{ transform: `translateY(${vPad}px)` }">
            <div v-for="c in filteredChannels.slice(vStart, vEnd)" :key="c.id" class="epg-row">
              <div class="ch">
                <ChannelLogo :ch="c" />
                <div style="min-width: 0;">
                  <div class="nm" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ c.tvg_name }}</div>
                  <div class="num mono">#{{ c.channelNo ?? '—' }}</div>
                </div>
              </div>
              <div class="epg-progs" :style="{ width: totalW + 'px' }">
                <div v-for="(p, i) in progs(c)" :key="i"
                     :class="['epg-prog', { live: isLive(p) }]"
                     :style="{ left: progLeft(p) + 'px', width: progWidth(p) + 'px' }"
                     @click="open(c, p)"
                     :title="`${p.title} · ${formatTime(p.start)}–${formatTime(p.end)}`">
                  <div class="t">{{ p.title }}</div>
                  <div class="sub">{{ formatTime(p.start) }}–{{ formatTime(p.end) }} · {{ p.cat }}</div>
                </div>
                <div class="now-line" :style="{ left: nowLeft() + 'px' }" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- List -->
    <div v-else style="overflow-y: auto; flex: 1;">
      <div v-for="c in filteredChannels" :key="c.id" style="border-bottom: 1px solid var(--hairline); padding: 14px var(--pad-card);">
        <div class="row" style="gap: 10px; margin-bottom: 10px;">
          <ChannelLogo :ch="c" />
          <div>
            <div style="font-weight: 600;">{{ c.tvg_name }}</div>
            <div class="mono muted" style="font-size: var(--fs-xs);">#{{ c.channelNo ?? '—' }} · {{ c.group }}</div>
          </div>
          <span class="spacer" />
          <Pill v-if="livePr(c)" tone="cyan">
            <span class="dot good" style="width: 6px; height: 6px;" />on now: {{ livePr(c)!.title }}
          </Pill>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px;">
          <div v-for="(p, i) in listProgs(c)" :key="i"
               :style="{
                 padding: '10px 12px',
                 background: (isLive(p)) ? 'var(--accent-soft)' : 'var(--bg-2)',
                 border: '1px solid ' + ((isLive(p)) ? 'oklch(0.82 0.13 220 / 0.4)' : 'var(--hairline)'),
                 borderRadius: '8px',
                 cursor: 'default'
               }"
               @click="open(c, p)">
            <div class="mono" :style="{ fontSize: 'var(--fs-xs)', color: (isLive(p)) ? 'var(--accent-hi)' : 'var(--text-2)' }">
              {{ formatTime(p.start) }}–{{ formatTime(p.end) }}
            </div>
            <div :style="{ fontWeight: 500, fontSize: 'var(--fs-sm)', marginTop: '2px', color: (isLive(p)) ? 'var(--accent-hi)' : 'var(--text-0)' }">
              {{ p.title }}
            </div>
            <div class="muted" style="font-size: var(--fs-xs); margin-top: 2px;">{{ p.cat }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Program panel -->
    <div v-if="viewing" class="stream-view-bg" @click="close">
      <div class="glass stream-view" @click.stop>
        <div class="stream-view-hd">
          <ChannelLogo :ch="viewing.channel" />
          <div style="min-width: 0; flex: 1;">
            <div class="row" style="gap: 8px;">
              <span style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{ viewing.channel.tvg_name }}</span>
              <span v-if="progState(viewing.prog) === 'live'" class="live-pill"><span class="dot" />LIVE</span>
              <Pill v-else-if="progState(viewing.prog) === 'upcoming'" tone="cyan"><Icon name="epg" :size="11" />upcoming</Pill>
              <Pill v-else>aired</Pill>
            </div>
            <div class="mono muted" style="font-size: var(--fs-xs); margin-top: 3px;">
              #{{ viewing.channel.channelNo ?? '—' }} · {{ viewing.channel.group }} · {{ viewing.channel.stream.res }}
            </div>
          </div>
          <Btn variant="ghost" size="sm" icon="x" @click="close" title="Close (Esc)" />
        </div>

        <div class="stream-view-body">
          <div class="player">
            <template v-if="progState(viewing.prog) === 'past'">
              <div style="position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 13px;">
                <div style="text-align: center;">
                  <Icon name="epg" :size="32" />
                  <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">Programme has ended</div>
                  <div class="mono" style="font-size: 11px; margin-top: 6px;">aired {{ formatTime(viewing.prog.start) }}–{{ formatTime(viewing.prog.end) }}</div>
                  <div style="margin-top: 16px;"><Btn variant="ghost" size="sm" icon="refresh">Check on-demand</Btn></div>
                </div>
              </div>
            </template>
            <template v-else-if="progState(viewing.prog) === 'upcoming'">
              <div style="position: absolute; inset: 0; display: grid; place-items: center; color: var(--text-2); font-size: 13px;">
                <div style="text-align: center;">
                  <Icon name="epg" :size="32" />
                  <div style="margin-top: 12px; font-weight: 600; color: var(--text-1); font-size: 15px;">Starts at {{ formatTime(viewing.prog.start) }}</div>
                  <div class="mono" style="font-size: 11px; margin-top: 6px;">in {{ humanizeDelta(viewing.prog.start - now) }}</div>
                  <div style="margin-top: 16px;"><Btn variant="primary" size="sm" icon="add">Set reminder</Btn></div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="stripes" />
              <div class="label mono">{{ viewing.channel.stream.res }} · LIVE</div>
              <div class="play"><div class="play-btn"><Icon name="play" :size="28" /></div></div>
              <div class="controls">
                <Icon name="pause" :size="14" />
                <span class="mono" style="font-size: 11px;">{{ formatTime(now) }}</span>
                <div class="track" />
                <span class="mono" style="font-size: 11px;">{{ formatTime(viewing.prog.end) }}</span>
              </div>
            </template>
          </div>

          <div>
            <div class="muted mono"
                 :style="{ fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600, color: progState(viewing.prog) === 'live' ? 'var(--accent-hi)' : 'var(--text-2)' }">
              {{ progState(viewing.prog) === 'live' ? 'ON NOW' : progState(viewing.prog) === 'upcoming' ? 'UP NEXT' : 'EARLIER TODAY' }} · {{ viewing.prog.cat }}
            </div>
            <h2 style="margin: 6px 0 8px; font-size: 22px; font-weight: 600; letter-spacing: -0.015em;">{{ viewing.prog.title }}</h2>
            <div class="row" style="gap: 6px;">
              <Pill tone="cyan"><Icon name="epg" :size="11" />{{ formatTime(viewing.prog.start) }}–{{ formatTime(viewing.prog.end) }}</Pill>
              <Pill>{{ humanizeDur(viewing.prog.end - viewing.prog.start) }}</Pill>
              <Pill>{{ viewing.prog.cat }}</Pill>
              <span class="spacer" />
              <span v-if="progState(viewing.prog) === 'live'" class="mono muted" style="font-size: 11px;">
                {{ Math.round(Math.min(1, Math.max(0, (now - viewing.prog.start) / (viewing.prog.end - viewing.prog.start))) * 100) }}% elapsed · {{ humanizeDelta(viewing.prog.end - now) }} left
              </span>
            </div>
            <div v-if="progState(viewing.prog) === 'live'" style="margin-top: 10px; height: 4px; border-radius: 999px; background: var(--bg-3); overflow: hidden;">
              <div :style="{ height: '100%', width: (Math.min(1, Math.max(0, (now - viewing.prog.start) / (viewing.prog.end - viewing.prog.start))) * 100) + '%', background: 'var(--accent)', boxShadow: '0 0 12px var(--accent)' }" />
            </div>
          </div>

          <div class="card" style="background: var(--bg-2); padding: 16px;">
            <div style="font-size: var(--fs-sm); line-height: 1.55; color: var(--text-1);">
              {{ blurbs[viewing.prog.cat] || 'A scheduled programme on this channel.' }}
            </div>
          </div>

          <div class="card" style="background: var(--bg-2); padding: 16px;">
            <div style="font-size: var(--fs-sm); font-weight: 600; margin-bottom: 12px;">Programme details</div>
            <div class="kv-list">
              <div class="k">Channel</div>
              <div class="v">{{ viewing.channel.tvg_name }} <span class="mono muted">· #{{ viewing.channel.channelNo ?? '—' }}</span></div>
              <div class="k">Group</div><div class="v">{{ viewing.channel.group }}</div>
              <div class="k">Time</div><div class="v mono">{{ formatTime(viewing.prog.start) }} – {{ formatTime(viewing.prog.end) }}</div>
              <div class="k">Duration</div><div class="v mono">{{ humanizeDur(viewing.prog.end - viewing.prog.start) }}</div>
              <div class="k">Category</div><div class="v">{{ viewing.prog.cat }}</div>
              <div class="k">Resolution</div><div class="v mono">{{ viewing.channel.stream.res }}</div>
              <div class="k">TVG-ID</div>
              <div class="v mono">
                <template v-if="viewing.channel.tvg_id">{{ viewing.channel.tvg_id }}</template>
                <span v-else style="color: var(--text-3);">—</span>
              </div>
              <div class="k">Source</div>
              <div class="v"><Pill tone="cyan">{{ viewing.channel.source }}</Pill></div>
              <div class="k">EPG match</div>
              <div class="v">
                <Pill v-if="viewing.channel.epgState === 'matched'" tone="good"><Icon name="check" :size="11" />matched</Pill>
                <Pill v-else tone="warn">unmatched</Pill>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
