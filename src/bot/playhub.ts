/**
 * Direct Ravensburger Playhub API client
 * Bypasses MCP for slash commands to get structured JSON responses
 */

import { geocodeCity } from './geocode.js';
import { fetchWithRetry } from './fetchWithRetry.js';
import { createTtlCache } from './ttlCache.js';

const API_BASE = 'https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2';
/** Public event page URL (used for leaderboard "events included" links). */
const PLAYHUB_EVENT_URL = 'https://tcg.ravensburgerplay.com/events';
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Max entries per cache to avoid unbounded memory growth; LRU eviction. */
const CACHE_MAX_SIZE = 1000;

const eventsByCityCache = createTtlCache<{
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}>({ maxSize: CACHE_MAX_SIZE });
const eventsByStoreCache = createTtlCache<{
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}>({ maxSize: CACHE_MAX_SIZE });
const eventsByCoordsCache = createTtlCache<{
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}>({ maxSize: CACHE_MAX_SIZE });
const storesSearchCache = createTtlCache<{
  stores: GameStore[];
  total: number;
  location?: string;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}>({ maxSize: CACHE_MAX_SIZE });

/** TTL for leaderboard caches: past events/rounds are immutable (long TTL); in-progress use short TTL. */
const LEADERBOARD_CACHE_TTL_PAST_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (immutable)
const LEADERBOARD_CACHE_TTL_IN_PROGRESS_MS = 60 * 1000; // 1 min
const eventDetailsCache = createTtlCache<Event>({ maxSize: CACHE_MAX_SIZE });
const roundStandingsCache = createTtlCache<StandingsResponse>({ maxSize: CACHE_MAX_SIZE });

const headers = {
  'Content-Type': 'application/json',
  Referer: 'https://tcg.ravensburgerplay.com/',
};

type DiscordTimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R';

function toDiscordTimestamp(
  date: Date | string,
  style: DiscordTimestampStyle = 'f'
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const unixSeconds = Math.floor(d.getTime() / 1000);
  return `<t:${unixSeconds}:${style}>`;
}

/** A single tournament round (from event details). */
export interface TournamentRound {
  id: number;
  round_number: number;
  status?: string;
  standings_status?: string;
  [key: string]: unknown;
}

/** A tournament phase containing rounds (e.g. Swiss, Top Cut). */
export interface TournamentPhase {
  id: number;
  phase_name?: string;
  status?: string;
  rounds: TournamentRound[];
  [key: string]: unknown;
}

export interface Event {
  id: number;
  name: string;
  description?: string;
  start_datetime: string;
  cost_in_cents?: number;
  currency?: string;
  capacity?: number;
  registered_user_count?: number;
  display_status?: string;
  store?: {
    id: number;
    name: string;
    city?: string;
    state?: string;
    full_address?: string;
  };
  gameplay_format?: {
    id: string;
    name: string;
  };
  /** Tournament phases and rounds (when event has rounds). Used for standings. */
  tournament_phases?: TournamentPhase[];
}

/** One row from tournament round standings (paginated API). */
export interface StandingEntry {
  rank?: number;
  placement?: number;
  player?: { best_identifier?: string; id?: number; [key: string]: unknown };
  player_name?: string;
  username?: string;
  display_name?: string;
  wins?: number;
  losses?: number;
  record?: string;
  match_record?: string;
  match_points?: number;
  opponent_match_win_pct?: number;
  opponent_match_win_percentage?: number;
  game_win_pct?: number;
  game_win_percentage?: number;
  /** Display name/username when available; prefer over player.best_identifier */
  user_event_status?: {
    best_identifier?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StandingsResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  previous_page_number: number | null;
  results: StandingEntry[];
}

export interface EventsResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  results: Event[];
}

export interface SearchEventsParams {
  city: string;
  radiusMiles?: number;
  statuses?: ('upcoming' | 'inProgress' | 'past')[];
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  pageSize?: number;
  page?: number;
}

/** Search events by city - returns structured data */
export async function searchEventsByCity(
  params: SearchEventsParams
): Promise<{
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
} | { error: string }> {
  const {
    city,
    radiusMiles = 25,
    statuses = ['upcoming', 'inProgress'],
    startDate,
    endDate,
    pageSize = 25,
    page = 1,
  } = params;

  const cacheKey = `eventsByCity:${[
    city.toLowerCase(),
    radiusMiles,
    statuses.join(','),
    startDate ?? '',
    endDate ?? '',
    pageSize,
    page,
  ].join('|')}`;
  const cached = eventsByCityCache.get(cacheKey);
  if (cached) return cached;

  // Geocode the city
  const geo = await geocodeCity(city);
  if (!geo) {
    return { error: `Could not find location: ${city}` };
  }

  // Build query params
  const query = new URLSearchParams();
  query.set('game_slug', 'disney-lorcana');
  query.set('latitude', geo.lat.toString());
  query.set('longitude', geo.lon.toString());
  query.set('num_miles', radiusMiles.toString());
  query.set('page', page.toString());
  query.set('page_size', pageSize.toString());

  for (const status of statuses) {
    query.append('display_statuses', status);
  }

  if (startDate) {
    query.set('start_date_after', `${startDate}T00:00:00Z`);
  }
  if (endDate) {
    query.set('start_date_before', `${endDate}T23:59:59Z`);
  }

  const url = `${API_BASE}/events/?${query.toString()}`;
  const res = await fetchWithRetry(url, { headers });

  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }

  const data = (await res.json()) as EventsResponse;

  const result = {
    events: data.results,
    location: geo.display_name,
    total: data.count,
    currentPage: data.current_page_number,
    nextPage: data.next_page_number,
    pageSize: data.page_size,
  };
  eventsByCityCache.set(cacheKey, result, SEARCH_CACHE_TTL_MS);
  return result;
}

export interface SearchEventsByCoordsParams {
  latitude: number;
  longitude: number;
  /** Display name for the location (e.g. subscription.city) used in result.location */
  locationLabel?: string;
  radiusMiles?: number;
  statuses?: ('upcoming' | 'inProgress' | 'past')[];
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  pageSize?: number;
  page?: number;
}

/** Search events by latitude/longitude - no geocoding. Use for digests to avoid Nominatim rate limits. */
export async function searchEventsByCoords(
  params: SearchEventsByCoordsParams
): Promise<{
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
} | { error: string }> {
  const {
    latitude,
    longitude,
    locationLabel,
    radiusMiles = 25,
    statuses = ['upcoming', 'inProgress'],
    startDate,
    endDate,
    pageSize = 25,
    page = 1,
  } = params;

  const cacheKey = `eventsByCoords:${[
    latitude.toFixed(4),
    longitude.toFixed(4),
    radiusMiles,
    statuses.join(','),
    startDate ?? '',
    endDate ?? '',
    pageSize,
    page,
  ].join('|')}`;
  const cached = eventsByCoordsCache.get(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  query.set('game_slug', 'disney-lorcana');
  query.set('latitude', latitude.toString());
  query.set('longitude', longitude.toString());
  query.set('num_miles', radiusMiles.toString());
  query.set('page', page.toString());
  query.set('page_size', pageSize.toString());

  for (const status of statuses) {
    query.append('display_statuses', status);
  }

  if (startDate) {
    query.set('start_date_after', `${startDate}T00:00:00Z`);
  }
  if (endDate) {
    query.set('start_date_before', `${endDate}T23:59:59Z`);
  }

  const url = `${API_BASE}/events/?${query.toString()}`;
  const res = await fetchWithRetry(url, { headers });

  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }

  const data = (await res.json()) as EventsResponse;

  const result = {
    events: data.results,
    location: locationLabel ?? `${latitude},${longitude}`,
    total: data.count,
    currentPage: data.current_page_number,
    nextPage: data.next_page_number,
    pageSize: data.page_size,
  };
  eventsByCoordsCache.set(cacheKey, result, SEARCH_CACHE_TTL_MS);
  return result;
}

export interface SearchEventsByStoreParams {
  storeId: number;
  storeLabel?: string;
  statuses?: ('upcoming' | 'inProgress' | 'past')[];
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  pageSize?: number;
  page?: number;
}

/** Search events by store - returns structured data */
export async function searchEventsByStore(
  params: SearchEventsByStoreParams
): Promise<{
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
} | { error: string }> {
  const {
    storeId,
    storeLabel,
    statuses = ['upcoming', 'inProgress'],
    startDate,
    endDate,
    pageSize = 25,
    page = 1,
  } = params;

  const cacheKey = `eventsByStore:${[
    storeId,
    storeLabel ?? '',
    statuses.join(','),
    startDate ?? '',
    endDate ?? '',
    pageSize,
    page,
  ].join('|')}`;
  const cached = eventsByStoreCache.get(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  query.set('game_slug', 'disney-lorcana');
  query.set('store_id', storeId.toString());
  query.set('page', page.toString());
  query.set('page_size', pageSize.toString());

  for (const status of statuses) {
    query.append('display_statuses', status);
  }

  if (startDate) {
    query.set('start_date_after', `${startDate}T00:00:00Z`);
  }
  if (endDate) {
    query.set('start_date_before', `${endDate}T23:59:59Z`);
  }

  const url = `${API_BASE}/events/?${query.toString()}`;
  const res = await fetchWithRetry(url, { headers });

  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }

  const data = (await res.json()) as EventsResponse;
  const location = storeLabel || data.results[0]?.store?.name || `Store ${storeId}`;

  const result = {
    events: data.results,
    location,
    total: data.count,
    currentPage: data.current_page_number,
    nextPage: data.next_page_number,
    pageSize: data.page_size,
  };
  eventsByStoreCache.set(cacheKey, result, SEARCH_CACHE_TTL_MS);
  return result;
}

// ============ Stores ============

export interface Store {
  id: number;
  name: string;
  full_address?: string;
  city?: string;
  state?: string;
  country?: string;
  website?: string;
  phone_number?: string;
  distance_in_miles?: number;
}

export interface GameStore {
  id: string;
  store: Store;
  distance_in_miles?: number;
}

interface StoresResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  results: GameStore[];
}

export interface SearchStoresParams {
  query?: string;
  city?: string;
  radiusMiles?: number;
  pageSize?: number;
  page?: number;
}

/** Search stores by name and/or location */
export async function searchStores(
  params: SearchStoresParams
): Promise<{
  stores: GameStore[];
  total: number;
  location?: string;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
} | { error: string }> {
  const { query, city, radiusMiles = 50, pageSize = 25, page = 1 } = params;

  const cacheKey = `stores:${[
    query?.toLowerCase() ?? '',
    city?.toLowerCase() ?? '',
    radiusMiles,
    pageSize,
    page,
  ].join('|')}`;
  const cached = storesSearchCache.get(cacheKey);
  if (cached) return cached;

  const urlParams = new URLSearchParams();
  urlParams.set('game_id', '1'); // Lorcana
  urlParams.set('page', page.toString());
  urlParams.set('page_size', pageSize.toString());

  if (query) {
    urlParams.set('search', query);
  }

  let locationName: string | undefined;

  // If city provided, geocode and add location params
  if (city) {
    const geo = await geocodeCity(city);
    if (!geo) {
      return { error: `Could not find location: ${city}` };
    }
    urlParams.set('latitude', geo.lat.toString());
    urlParams.set('longitude', geo.lon.toString());
    urlParams.set('num_miles', radiusMiles.toString());
    locationName = geo.display_name;
  }

  const url = `${API_BASE}/game-stores/?${urlParams.toString()}`;
  const res = await fetchWithRetry(url, { headers });

  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }

  const data = (await res.json()) as StoresResponse;

  const result = {
    stores: data.results,
    total: data.count,
    location: locationName,
    currentPage: data.current_page_number,
    nextPage: data.next_page_number,
    pageSize: data.page_size,
  };
  storesSearchCache.set(cacheKey, result, SEARCH_CACHE_TTL_MS);
  return result;
}

/** Format store for Discord - compact one-liner */
export function formatStoreCompact(gameStore: GameStore): string {
  const store = gameStore.store;
  const parts: string[] = [`**${store.name}**`];

  // Location - try multiple fields
  const location: string[] = [];
  if (store.city) location.push(store.city);
  if (store.state) location.push(store.state);
  if (location.length > 0) {
    parts.push(location.join(', '));
  } else if (store.full_address) {
    // Fallback to full address if no city/state
    parts.push(store.full_address);
  }

  // Distance (if available from location search)
  const distance = gameStore.distance_in_miles ?? store.distance_in_miles;
  if (distance !== undefined && typeof distance === 'number') {
    parts.push(`${distance.toFixed(1)} mi`);
  }

  // Website (non-embed link)
  if (store.website) {
    const url = store.website.startsWith('http')
      ? store.website
      : `https://${store.website}`;
    parts.push(`[Website](<${url}>)`);
  }

  return `• ${parts.join(' – ')}`;
}

// ============ Event details & standings ============

/** Fetch full event details (including tournament_phases for standings). Cached: long TTL for past events, 1 min for in-progress. */
export async function getEventDetails(eventId: number): Promise<Event | { error: string }> {
  const key = String(eventId);
  const cached = eventDetailsCache.get(key);
  if (cached !== undefined) return cached;

  const url = `${API_BASE}/events/${eventId}/`;
  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }
  const event = (await res.json()) as Event;
  const ttlMs =
    event.display_status === 'past'
      ? LEADERBOARD_CACHE_TTL_PAST_MS
      : LEADERBOARD_CACHE_TTL_IN_PROGRESS_MS;
  eventDetailsCache.set(key, event, ttlMs);
  return event;
}

/** Fetch paginated standings for a tournament round. Cached: long TTL when event is past, 1 min for in-progress. */
export async function getTournamentRoundStandings(
  roundId: number,
  page: number = 1,
  pageSize: number = 50,
  options?: { isPastEvent?: boolean }
): Promise<StandingsResponse | { error: string }> {
  const cacheKey = `${roundId}-${page}-${pageSize}`;
  const cached = roundStandingsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = new URL(`${API_BASE}/tournament-rounds/${roundId}/standings/paginated/`);
  url.searchParams.set('page', page.toString());
  url.searchParams.set('page_size', pageSize.toString());
  const res = await fetchWithRetry(url.toString(), { headers });
  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }
  const data = (await res.json()) as StandingsResponse;
  const ttlMs =
    options?.isPastEvent === true
      ? LEADERBOARD_CACHE_TTL_PAST_MS
      : LEADERBOARD_CACHE_TTL_IN_PROGRESS_MS;
  roundStandingsCache.set(cacheKey, data, ttlMs);
  return data;
}

/** Priority for round order: try rounds that likely have final standings first (0 = highest). */
function roundStandingsPriority(standingsStatus: string | undefined): number {
  if (!standingsStatus) return 1;
  const s = standingsStatus.toLowerCase();
  if (
    s === 'completed' ||
    s === 'final' ||
    s === 'published' ||
    s === 'closed'
  ) {
    return 0;
  }
  if (
    s === 'pending' ||
    s === 'in_progress' ||
    s === 'in progress'
  ) {
    return 2;
  }
  return 1;
}

/**
 * Get event standings from the latest completed round that has data.
 * Uses event details (tournament_phases), tries rounds with standings_status indicating
 * final standings first when available, then newest-first by round_number.
 */
export async function getEventStandings(
  eventId: number,
  pageSize: number = 50
): Promise<{ event: Event; standings: StandingEntry[] } | { error: string } | null> {
  const eventResult = await getEventDetails(eventId);
  if ('error' in eventResult) return eventResult;

  const event = eventResult;
  const phases = event.tournament_phases;
  if (!phases?.length) {
    return null;
  }

  const allRounds: {
    id: number;
    round_number: number;
    phase_name?: string;
    standings_status?: string;
  }[] = [];
  for (const phase of phases) {
    if (!phase.rounds?.length) continue;
    for (const r of phase.rounds) {
      allRounds.push({
        id: r.id,
        round_number: r.round_number,
        phase_name: phase.phase_name,
        standings_status: r.standings_status,
      });
    }
  }
  allRounds.sort((a, b) => {
    const pa = roundStandingsPriority(a.standings_status);
    const pb = roundStandingsPriority(b.standings_status);
    if (pa !== pb) return pa - pb;
    return b.round_number - a.round_number;
  });

  const isPastEvent = event.display_status === 'past';
  for (const round of allRounds) {
    const standingsRes = await getTournamentRoundStandings(round.id, 1, pageSize, {
      isPastEvent,
    });
    if ('error' in standingsRes) continue;
    if (standingsRes.results.length > 0) {
      return { event, standings: standingsRes.results };
    }
  }
  return null;
}

/** Format a single standing entry for Discord (rank, name, record, optional OMWP/GWP). */
export function formatStandingEntry(entry: StandingEntry, index: number): string {
  const rank = entry.rank ?? entry.placement ?? index + 1;
  const name =
    entry.user_event_status?.best_identifier ??
    entry.player?.best_identifier ??
    entry.player_name ??
    entry.display_name ??
    entry.username ??
    '—';
  const lines: string[] = [`${rank}. ${name}`];
  const record =
    entry.record ??
    entry.match_record ??
    (entry.wins !== undefined || entry.losses !== undefined
      ? `${entry.wins ?? 0}-${entry.losses ?? 0}`
      : undefined);
  if (record) {
    lines.push(`   Record: ${record}`);
  }
  if (entry.match_points !== undefined) {
    lines.push(`   Match points: ${entry.match_points}`);
  }
  const omwp = entry.opponent_match_win_pct ?? entry.opponent_match_win_percentage;
  if (omwp !== undefined) {
    lines.push(`   OMWP: ${(Number(omwp) * 100).toFixed(1)}%`);
  }
  const gwp = entry.game_win_pct ?? entry.game_win_percentage;
  if (gwp !== undefined) {
    lines.push(`   GWP: ${(Number(gwp) * 100).toFixed(1)}%`);
  }
  return lines.join('\n');
}

// ============ Player leaderboard (aggregate standings across events) ============

export const MAX_LEADERBOARD_DATE_RANGE_DAYS = 93;
export const MAX_LEADERBOARD_RADIUS_MILES = 100;
export const MAX_LEADERBOARD_LIMIT = 100;

export type LeaderboardSortBy =
  | 'total_wins'
  | 'events_played'
  | 'win_rate'
  | 'best_placement';

export interface PlayerStats {
  playerName: string;
  totalWins: number;
  totalLosses: number;
  eventsPlayed: number;
  bestPlacement: number;
  firstPlaceFinishes: number;
  placements: number[];
}

export interface LeaderboardResult {
  players: PlayerStats[];
  eventsAnalyzed: number;
  eventsIncluded: Array<{ id: number; name: string; startDate: string }>;
  dateRange: { start: string; end: string };
  filters?: { city?: string; store?: string };
}

function parseRecordToWinsLosses(
  record: string | undefined
): { wins: number; losses: number } {
  if (typeof record !== 'string' || !record.trim()) return { wins: 0, losses: 0 };
  const parts = record.split('-').map((s) => parseInt(s.trim(), 10));
  if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return { wins: parts[0], losses: parts[1] };
  }
  return { wins: 0, losses: 0 };
}

/**
 * Stable key for aggregating a player across events.
 * Uses player.id when available (most stable), otherwise falls back to player.best_identifier.
 * Does NOT use user_event_status.best_identifier since that can vary per-event.
 */
function standingPlayerKey(entry: StandingEntry): string {
  // Prefer player.id as the most stable identifier
  if (entry.player?.id !== undefined && entry.player.id !== null) {
    return `player_id:${entry.player.id}`;
  }
  // Fall back to player.best_identifier (first name + last initial, stable across events)
  return (
    entry.player?.best_identifier ??
    entry.player_name ??
    entry.display_name ??
    entry.username ??
    '—'
  );
}

/**
 * Best display name for a player (for output/formatting).
 * Prefers user_event_status.best_identifier (display name/username) when available.
 */
function standingPlayerDisplayName(entry: StandingEntry): string {
  return (
    entry.user_event_status?.best_identifier ??
    entry.player?.best_identifier ??
    entry.player_name ??
    entry.display_name ??
    entry.username ??
    '—'
  );
}

function standingPlacement(entry: StandingEntry, index: number): number {
  return entry.rank ?? entry.placement ?? index + 1;
}

function standingWinsLosses(entry: StandingEntry): { wins: number; losses: number } {
  if (
    entry.wins !== undefined &&
    entry.wins !== null &&
    entry.losses !== undefined &&
    entry.losses !== null
  ) {
    return { wins: Number(entry.wins), losses: Number(entry.losses) };
  }
  return parseRecordToWinsLosses(entry.record ?? entry.match_record);
}

/** Run async tasks with bounded concurrency; preserves input order. Failed items are undefined. */
async function runWithBoundedConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < items.length) {
      const i = index++;
      const item = items[i];
      try {
        results[i] = await fn(item);
      } catch {
        results[i] = undefined;
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/** Max concurrent event-standing fetches to avoid latency explosion while not overwhelming API. */
const LEADERBOARD_EVENT_CONCURRENCY = 8;

/** Fetch standings for multiple events with bounded concurrency; skips events with no standings. */
async function fetchAllEventStandings(
  eventIds: number[]
): Promise<Array<{ event: Event; standings: StandingEntry[] }>> {
  const raw = await runWithBoundedConcurrency(
    eventIds,
    LEADERBOARD_EVENT_CONCURRENCY,
    async (eventId) => {
      try {
        return await getEventStandings(eventId, 100);
      } catch {
        return null;
      }
    }
  );
  const results: Array<{ event: Event; standings: StandingEntry[] }> = [];
  for (const one of raw) {
    if (one && !('error' in one) && one !== null) {
      results.push(one);
    }
  }
  return results;
}

function aggregateStandingsToPlayers(
  eventStandings: Array<{ event: Event; standings: StandingEntry[] }>,
  minEvents: number,
  sortBy: LeaderboardSortBy,
  limit: number
): PlayerStats[] {
  const agg = new Map<
    string,
    {
      displayName: string;
      hasUserEventStatus: boolean;
      wins: number;
      losses: number;
      eventsPlayed: number;
      placements: number[];
    }
  >();
  for (const { standings } of eventStandings) {
    for (let i = 0; i < standings.length; i++) {
      const entry = standings[i];
      const key = standingPlayerKey(entry);
      if (key === '—') continue;
      const displayName = standingPlayerDisplayName(entry);
      const hasUserEventStatus = entry.user_event_status?.best_identifier !== undefined;
      const placement = standingPlacement(entry, i);
      const { wins, losses } = standingWinsLosses(entry);
      let rec = agg.get(key);
      if (!rec) {
        rec = {
          displayName,
          hasUserEventStatus,
          wins: 0,
          losses: 0,
          eventsPlayed: 0,
          placements: [],
        };
        agg.set(key, rec);
      } else if (hasUserEventStatus && !rec.hasUserEventStatus) {
        // Prefer display name from user_event_status when we find one
        rec.displayName = displayName;
        rec.hasUserEventStatus = true;
      }
      rec.wins += wins;
      rec.losses += losses;
      rec.eventsPlayed += 1;
      rec.placements.push(placement);
    }
  }
  let players: PlayerStats[] = Array.from(agg.values())
    .filter((r) => r.eventsPlayed >= minEvents)
    .map((r) => ({
      playerName: r.displayName,
      totalWins: r.wins,
      totalLosses: r.losses,
      eventsPlayed: r.eventsPlayed,
      bestPlacement: Math.min(...r.placements),
      firstPlaceFinishes: r.placements.filter((p) => p === 1).length,
      placements: r.placements,
    }));
  if (sortBy === 'total_wins') {
    players.sort((a, b) => {
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      // Tie on wins: fewer losses first (better record), then better best placement
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return a.bestPlacement - b.bestPlacement;
    });
  } else if (sortBy === 'events_played') {
    players.sort((a, b) => {
      if (b.eventsPlayed !== a.eventsPlayed) return b.eventsPlayed - a.eventsPlayed;
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return a.bestPlacement - b.bestPlacement;
    });
  } else if (sortBy === 'win_rate') {
    players.sort((a, b) => {
      const rateA =
        a.totalWins + a.totalLosses > 0
          ? a.totalWins / (a.totalWins + a.totalLosses)
          : 0;
      const rateB =
        b.totalWins + b.totalLosses > 0
          ? b.totalWins / (b.totalWins + b.totalLosses)
          : 0;
      if (rateB !== rateA) return rateB - rateA;
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return a.bestPlacement - b.bestPlacement;
    });
  } else {
    players.sort((a, b) => {
      if (a.bestPlacement !== b.bestPlacement) return a.bestPlacement - b.bestPlacement;
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return 0;
    });
  }
  return players.slice(0, limit);
}

export interface GetPlayerLeaderboardByCityParams {
  city: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  radiusMiles?: number;
  limit?: number;
  minEvents?: number;
  sortBy?: LeaderboardSortBy;
}

/** Aggregate player leaderboard for past and in-progress events near a city (date range max 93 days). */
export async function getPlayerLeaderboardByCity(
  params: GetPlayerLeaderboardByCityParams
): Promise<LeaderboardResult | { error: string }> {
  const {
    city,
    startDate,
    endDate,
    radiusMiles = 50,
    limit = 20,
    minEvents = 1,
    sortBy = 'total_wins',
  } = params;

  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T23:59:59Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { error: 'Dates must be valid YYYY-MM-DD.' };
  }
  if (start > end) {
    return { error: 'start_date must be on or before end_date.' };
  }
  const daysDiff = Math.round(
    (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)
  );
  if (daysDiff > MAX_LEADERBOARD_DATE_RANGE_DAYS) {
    return {
      error: `Date range cannot exceed ${MAX_LEADERBOARD_DATE_RANGE_DAYS} days (about 3 months).`,
    };
  }

  const radius = Math.min(
    MAX_LEADERBOARD_RADIUS_MILES,
    Math.max(0, radiusMiles)
  );
  const limitCap = Math.min(MAX_LEADERBOARD_LIMIT, Math.max(1, limit));
  const minEventsCap = Math.max(1, minEvents);

  const geo = await geocodeCity(city);
  if (!geo) {
    return { error: `Could not find location: ${city}` };
  }

  const allEvents: Array<{ id: number; name: string; start_datetime: string }> = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const result = await searchEventsByCoords({
      latitude: geo.lat,
      longitude: geo.lon,
      locationLabel: geo.display_name,
      radiusMiles: radius,
      statuses: ['past', 'inProgress'],
      startDate,
      endDate,
      pageSize: 100,
      page,
    });
    if ('error' in result) return result;
    for (const e of result.events) {
      allEvents.push({
        id: e.id,
        name: e.name,
        start_datetime: e.start_datetime,
      });
    }
    hasMore =
      result.events.length === 100 && result.total > allEvents.length;
    page += 1;
  }

  if (allEvents.length === 0) {
    return {
      error: `No past or in-progress events found near ${geo.display_name} for ${startDate} – ${endDate}. Try a larger radius or different dates.`,
    };
  }

  const eventStandings = await fetchAllEventStandings(allEvents.map((e) => e.id));
  const players = aggregateStandingsToPlayers(
    eventStandings,
    minEventsCap,
    sortBy,
    limitCap
  );

  return {
    players,
    eventsAnalyzed: eventStandings.length,
    eventsIncluded: eventStandings.map(({ event }) => ({
      id: event.id,
      name: event.name,
      startDate: event.start_datetime.slice(0, 10),
    })),
    dateRange: { start: startDate, end: endDate },
    filters: { city: geo.display_name },
  };
}

export interface GetPlayerLeaderboardByStoreParams {
  storeId: number;
  storeLabel?: string;
  startDate: string;
  endDate: string;
  limit?: number;
  minEvents?: number;
  sortBy?: LeaderboardSortBy;
}

/** Aggregate player leaderboard for past and in-progress events at a specific store (date range max 93 days). */
export async function getPlayerLeaderboardByStore(
  params: GetPlayerLeaderboardByStoreParams
): Promise<LeaderboardResult | { error: string }> {
  const {
    storeId,
    storeLabel,
    startDate,
    endDate,
    limit = 20,
    minEvents = 1,
    sortBy = 'total_wins',
  } = params;

  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T23:59:59Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { error: 'Dates must be valid YYYY-MM-DD.' };
  }
  if (start > end) {
    return { error: 'start_date must be on or before end_date.' };
  }
  const daysDiff = Math.round(
    (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)
  );
  if (daysDiff > MAX_LEADERBOARD_DATE_RANGE_DAYS) {
    return {
      error: `Date range cannot exceed ${MAX_LEADERBOARD_DATE_RANGE_DAYS} days (about 3 months).`,
    };
  }

  const limitCap = Math.min(MAX_LEADERBOARD_LIMIT, Math.max(1, limit));
  const minEventsCap = Math.max(1, minEvents);

  const allEvents: Array<{ id: number; name: string; start_datetime: string }> = [];
  let page = 1;
  let hasMore = true;
  let resolvedStoreLabel = storeLabel;
  while (hasMore) {
    const result = await searchEventsByStore({
      storeId,
      storeLabel: resolvedStoreLabel,
      statuses: ['past', 'inProgress'],
      startDate,
      endDate,
      pageSize: 100,
      page,
    });
    if ('error' in result) return result;
    for (const e of result.events) {
      allEvents.push({
        id: e.id,
        name: e.name,
        start_datetime: e.start_datetime,
      });
      if (!resolvedStoreLabel && e.store?.name) {
        resolvedStoreLabel = e.store.name;
      }
    }
    hasMore =
      result.events.length === 100 && result.total > allEvents.length;
    page += 1;
  }

  if (allEvents.length === 0) {
    return {
      error: `No past or in-progress events found at store ${storeId} for ${startDate} – ${endDate}. Try different dates.`,
    };
  }

  const eventStandings = await fetchAllEventStandings(allEvents.map((e) => e.id));
  const players = aggregateStandingsToPlayers(
    eventStandings,
    minEventsCap,
    sortBy,
    limitCap
  );

  return {
    players,
    eventsAnalyzed: eventStandings.length,
    eventsIncluded: eventStandings.map(({ event }) => ({
      id: event.id,
      name: event.name,
      startDate: event.start_datetime.slice(0, 10),
    })),
    dateRange: { start: startDate, end: endDate },
    filters: { store: resolvedStoreLabel ?? `Store ${storeId}` },
  };
}

/** Format one leaderboard row for Discord (single compact line). */
export function formatLeaderboardEntry(entry: PlayerStats, rank: number): string {
  const winRate =
    entry.totalWins + entry.totalLosses > 0
      ? ((entry.totalWins / (entry.totalWins + entry.totalLosses)) * 100).toFixed(
          1
        )
      : '—';
  const ord =
    entry.bestPlacement === 1
      ? 'st'
      : entry.bestPlacement === 2
        ? 'nd'
        : entry.bestPlacement === 3
          ? 'rd'
          : 'th';
  const eventLabel = entry.eventsPlayed === 1 ? 'event' : 'events';
  return `${rank}. ${entry.playerName} — ${entry.totalWins}W-${entry.totalLosses}L · ${entry.eventsPlayed} ${eventLabel} · ${winRate}% · Best ${entry.bestPlacement}${ord}`;
}

/** Build full leaderboard message for Discord. */
export function formatLeaderboard(
  result: LeaderboardResult,
  sortLabel: string
): string {
  const lines: string[] = [];
  const filterParts: string[] = [];
  if (result.filters?.city) filterParts.push(`near ${result.filters.city}`);
  if (result.filters?.store) filterParts.push(`at ${result.filters.store}`);
  const filterStr = filterParts.length > 0 ? ` (${filterParts.join(' | ')})` : '';
  lines.push(`**Player Leaderboard**${filterStr}`);
  lines.push(
    `Period: ${result.dateRange.start} – ${result.dateRange.end} · Events analyzed: ${result.eventsAnalyzed}`
  );
  lines.push('');
  lines.push(`🏆 Top by ${sortLabel}`);
  lines.push('');
  for (let i = 0; i < result.players.length; i++) {
    lines.push(formatLeaderboardEntry(result.players[i], i + 1));
  }
  if (result.eventsIncluded.length > 0) {
    lines.push('');
    lines.push('Events included:');
    const maxEventsShown = 10;
    for (const e of result.eventsIncluded.slice(0, maxEventsShown)) {
      const link = `[${e.name}](<${PLAYHUB_EVENT_URL}/${e.id}>)`;
      lines.push(`• ${link} — ${e.startDate}`);
    }
    if (result.eventsIncluded.length > maxEventsShown) {
      lines.push(`• … and ${result.eventsIncluded.length - maxEventsShown} more`);
    }
  }
  return lines.join('\n');
}

// ============ Events ============

/** Format event for Discord - compact one-liner */
export function formatEventCompact(event: Event): string {
  const link = `[${event.name}](<https://tcg.ravensburgerplay.com/events/${event.id}>)`;

  // Format date/time using Discord timestamps (renders in reader's local timezone)
  const dateTime = toDiscordTimestamp(event.start_datetime, 'f');

  // Store
  const store = event.store?.name || '';

  // Fee
  let fee = 'Free';
  if (event.cost_in_cents && event.cost_in_cents > 0) {
    const dollars = event.cost_in_cents / 100;
    fee = `$${dollars.toFixed(2)}`;
  }

  const parts = [link, dateTime];
  if (store) parts.push(`@ ${store}`);
  parts.push(fee);

  return `• ${parts.join(' – ')}`;
}
