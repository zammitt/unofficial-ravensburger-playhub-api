/**
 * API client for Ravensburger PlayHub (events, stores, formats, categories, standings, cards, registrations).
 */

import type {
  CardQuickSearchResponse,
  CardSearchWithFiltersResponse,
  DeckbuilderCard,
  Event,
  EventCategory,
  EventQuickFilter,
  EventsResponse,
  GameSummary,
  GameStore,
  GeocodeResult,
  GameplayFormat,
  MatchesResponse,
  PlaceAutocompleteResponse,
  RegistrationsResponse,
  StandingEntry,
  StandingsResponse,
  StoresResponse,
} from "./types.js";
import { fetchWithRetry } from "./http.js";
import { createTtlCache } from "./ttlCache.js";

export const API_BASE = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2";
const PLAYHUB_WEB_BASE = "https://tcg.ravensburgerplay.com";
const DEBUG_API_LOGGING = /^(1|true|yes|on)$/i.test(process.env.LORCANA_MCP_DEBUG ?? "");

export const headers = {
  "Content-Type": "application/json",
  Referer: "https://tcg.ravensburgerplay.com/",
};

function debugApiLog(message: string): void {
  if (DEBUG_API_LOGGING) {
    console.error(message);
  }
}

// ============================================================================
// Statuses
// ============================================================================

/** Event statuses for tool schema. "all" expands to upcoming, inProgress, past when calling the API. */
export const STATUSES = ["upcoming", "inProgress", "past", "all"] as const;

const API_STATUSES = ["upcoming", "inProgress", "past"] as const;

/** Expand statuses for API: "all" or empty -> [upcoming, inProgress, past]. Other values passed through. */
export function expandStatusesForApi(statuses: readonly string[]): string[] {
  if (statuses.length === 0 || statuses.includes("all")) return [...API_STATUSES];
  return statuses.filter((s) => s !== "all") as string[];
}

// ============================================================================
// Format / category filter maps
// ============================================================================

let FORMAT_MAP: Map<string, string> = new Map();
let CATEGORY_MAP: Map<string, string> = new Map();

/** Load and cache formats and categories from the API (called at server startup). */
export async function loadFilterOptions(): Promise<void> {
  try {
    const [formats, categories] = await Promise.all([
      fetchGameplayFormats(),
      fetchCategories(),
    ]);
    updateFilterMaps(formats, categories);
    console.error(`Loaded ${FORMAT_MAP.size} formats and ${CATEGORY_MAP.size} categories from API`);
  } catch (error) {
    console.error("Warning: Failed to load filter options from API:", error);
  }
}

/** Update the in-memory format/category maps (e.g. after list_filters refresh). */
export function updateFilterMaps(formats: GameplayFormat[], categories: EventCategory[]): void {
  FORMAT_MAP = new Map(formats.map((f) => [f.name, f.id]));
  CATEGORY_MAP = new Map(categories.map((c) => [c.name, c.id]));
}

/** Resolve format display names to API IDs. */
export function resolveFormatIds(formatNames: string[]): string[] {
  const ids: string[] = [];
  for (const name of formatNames) {
    const id = FORMAT_MAP.get(name);
    if (id) ids.push(id);
    else console.error(`Warning: Unknown format "${name}"`);
  }
  return ids;
}

/** Resolve category display names to API IDs. */
export function resolveCategoryIds(categoryNames: string[]): string[] {
  const ids: string[] = [];
  for (const name of categoryNames) {
    const id = CATEGORY_MAP.get(name);
    if (id) ids.push(id);
    else console.error(`Warning: Unknown category "${name}"`);
  }
  return ids;
}

/** Resolve format names to IDs; throws if any name is unknown. */
export function resolveFormatIdsStrict(formatNames: string[]): string[] {
  const invalid: string[] = [];
  const ids: string[] = [];
  for (const name of formatNames) {
    const id = FORMAT_MAP.get(name);
    if (id) ids.push(id);
    else invalid.push(name);
  }
  if (invalid.length > 0) {
    throw new Error(`Unknown format(s). Use list_filters for valid names: ${invalid.join(", ")}`);
  }
  return ids;
}

/** Resolve category names to IDs; throws if any name is unknown. */
export function resolveCategoryIdsStrict(categoryNames: string[]): string[] {
  const invalid: string[] = [];
  const ids: string[] = [];
  for (const name of categoryNames) {
    const id = CATEGORY_MAP.get(name);
    if (id) ids.push(id);
    else invalid.push(name);
  }
  if (invalid.length > 0) {
    throw new Error(`Unknown category(s). Use list_filters for valid names: ${invalid.join(", ")}`);
  }
  return ids;
}

/** Reverse lookup: category template ID to display name. */
export function getCategoryName(templateId: string): string {
  for (const [name, id] of CATEGORY_MAP.entries()) {
    if (id === templateId) return name;
  }
  return templateId;
}

// ============================================================================
// Caching (TTL-based with LRU eviction)
// ============================================================================

const CACHE_MAX_SIZE = 1000;
const CACHE_TTL_PAST_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for completed events
const CACHE_TTL_LIVE_MS = 60 * 1000; // 1 min for in-progress events

const eventDetailsCache = createTtlCache<Event>({ maxSize: CACHE_MAX_SIZE });
const roundStandingsFullCache = createTtlCache<StandingEntry[]>({ maxSize: CACHE_MAX_SIZE });
const roundStandingsPaginatedCache = createTtlCache<StandingsResponse>({ maxSize: CACHE_MAX_SIZE });

/** Check if an event is completed (past). */
function isEventCompleted(event: Event): boolean {
  const status = event.display_status?.toLowerCase();
  const lifecycle = event.settings?.event_lifecycle_status?.toLowerCase();
  return status === "past" || lifecycle === "completed" || lifecycle === "past";
}

function cacheTtlForEvent(event: Event): number {
  return isEventCompleted(event) ? CACHE_TTL_PAST_MS : CACHE_TTL_LIVE_MS;
}

// ============================================================================
// Gameplay formats & categories
// ============================================================================

export async function fetchGameplayFormats(): Promise<GameplayFormat[]> {
  const url = `${API_BASE}/gameplay-formats/?game_slug=disney-lorcana`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) throw new Error("Failed to fetch formats");
  return response.json();
}

export async function fetchCategories(): Promise<EventCategory[]> {
  const url = `${API_BASE}/event-configuration-templates/?game_slug=disney-lorcana`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) throw new Error("Failed to fetch categories");
  return response.json();
}

export async function fetchEventQuickFilters(gameSlug: string = "disney-lorcana"): Promise<EventQuickFilter[]> {
  const url = `${API_BASE}/events/quick-filters/?game_slug=${encodeURIComponent(gameSlug)}`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch quick filters: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

// ============================================================================
// Games
// ============================================================================

export async function fetchGames(): Promise<GameSummary[]> {
  const url = `${API_BASE}/games/?lookup=slug&getFullData=0&timezoneOffset=0`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch games: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

export async function fetchGameDetails(gameSlug: string): Promise<GameSummary> {
  const url = `${API_BASE}/games/${encodeURIComponent(gameSlug)}/?lookup=slug&getFullData=1&timezoneOffset=0`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch game details: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

// ============================================================================
// Geocoding (via Ravensburger's proxy)
// ============================================================================

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const url = `${PLAYHUB_WEB_BASE}/api/address/geocode?address=${encodeURIComponent(address)}`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to geocode address: ${response.status} ${response.statusText} - ${text}`);
  }
  const payload = await response.json() as { data?: GeocodeResult | null; error?: unknown };
  return payload.data ?? null;
}

export async function geocodePlaceId(placeId: string): Promise<GeocodeResult | null> {
  const url = `${PLAYHUB_WEB_BASE}/api/address/geocode?placeId=${encodeURIComponent(placeId)}`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to geocode place ID: ${response.status} ${response.statusText} - ${text}`);
  }
  const payload = await response.json() as { data?: GeocodeResult | null; error?: unknown };
  return payload.data ?? null;
}

export async function autocompletePlaces(query: string, sessionToken: string): Promise<PlaceAutocompleteResponse> {
  const url = `${PLAYHUB_WEB_BASE}/api/google/places/autocomplete-places?q=${encodeURIComponent(query)}&t=${encodeURIComponent(sessionToken)}&field_mask=suggestions`;
  const response = await fetchWithRetry(url, { headers: { Referer: "https://tcg.ravensburgerplay.com/" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to autocomplete places: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

// ============================================================================
// Cards
// ============================================================================

export async function searchCardsQuick(query: string, gameId: number = 1): Promise<CardQuickSearchResponse> {
  const url = `${API_BASE}/deckbuilder/cards/quick-search/`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, game_id: gameId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to search cards: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

export async function searchCardsWithFilters(
  query: string,
  gameId: number = 1,
  limit: number = 50,
  offset: number = 0
): Promise<CardSearchWithFiltersResponse> {
  const url = `${API_BASE}/deckbuilder/cards/search-with-filters/`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, game_id: gameId, limit, offset }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to search cards with filters: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

export async function fetchCardById(cardId: string): Promise<DeckbuilderCard> {
  const url = `${API_BASE}/deckbuilder/cards/${encodeURIComponent(cardId)}/`;
  const response = await fetchWithRetry(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch card details: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

// ============================================================================
// Events
// ============================================================================

export async function fetchEvents(params: Record<string, string | string[]>): Promise<EventsResponse> {
  const url = new URL(`${API_BASE}/events/`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((v) => url.searchParams.append(key, v));
    } else if (value !== undefined && value !== "") {
      url.searchParams.append(key, value);
    }
  }

  debugApiLog(`[fetchEvents] URL: ${url.toString()}`);
  debugApiLog(`[fetchEvents] Params: ${JSON.stringify(params)}`);

  const response = await fetchWithRetry(url.toString(), { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json() as EventsResponse;
  debugApiLog(`[fetchEvents] Response: count=${data.count}, results=${data.results?.length ?? 0}`);
  return data;
}

/** Fetch full event details. Cached with TTL (7 days for past events, 1 min for in-progress). */
export async function fetchEventDetails(eventId: number): Promise<Event> {
  const key = String(eventId);
  const cached = eventDetailsCache.get(key);
  if (cached) return cached;

  const url = `${API_BASE}/events/${eventId}/`;
  const response = await fetchWithRetry(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const event = await response.json() as Event;
  eventDetailsCache.set(key, event, cacheTtlForEvent(event));
  return event;
}

export async function fetchEventRegistrations(
  eventId: number,
  page: number = 1,
  pageSize: number = 25
): Promise<RegistrationsResponse> {
  const url = new URL(`${API_BASE}/events/${eventId}/registrations/`);
  url.searchParams.set("page", page.toString());
  url.searchParams.set("page_size", pageSize.toString());
  const response = await fetchWithRetry(url.toString(), { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

// ============================================================================
// Tournament rounds (standings & matches)
// ============================================================================

/** Fetch paginated standings for a tournament round. Falls back to unpaginated endpoint for older events. */
export async function fetchTournamentRoundStandings(
  roundId: number,
  page: number = 1,
  pageSize: number = 25,
  options?: { isPastEvent?: boolean }
): Promise<StandingsResponse> {
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);

  const cacheKey = `${roundId}-${safePage}-${safePageSize}`;
  const cached = roundStandingsPaginatedCache.get(cacheKey);
  if (cached) return cached;

  const url = new URL(`${API_BASE}/tournament-rounds/${roundId}/standings/paginated/`);
  url.searchParams.set("page", safePage.toString());
  url.searchParams.set("page_size", safePageSize.toString());

  const response = await fetchWithRetry(url.toString(), { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  let paginated = await response.json() as StandingsResponse;

  // Some older events return empty paginated standings while unpaginated has data.
  if (paginated.results.length === 0 && (paginated.total ?? 0) === 0) {
    try {
      const fullStandings = await fetchTournamentRoundStandingsUnpaginated(roundId);
      if (fullStandings.length > 0) {
        paginated = paginateStandings(fullStandings, safePage, safePageSize);
      }
    } catch {
      // Keep the paginated empty response if fallback fails.
    }
  }

  const ttl = options?.isPastEvent ? CACHE_TTL_PAST_MS : CACHE_TTL_LIVE_MS;
  roundStandingsPaginatedCache.set(cacheKey, paginated, ttl);
  return paginated;
}

function paginateStandings(
  standings: StandingEntry[],
  page: number,
  pageSize: number
): StandingsResponse {
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);
  const total = standings.length;
  const startIndex = (safePage - 1) * safePageSize;
  const results = standings.slice(startIndex, startIndex + safePageSize);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));

  return {
    count: results.length,
    total,
    page_size: safePageSize,
    current_page_number: safePage,
    next_page_number: safePage < totalPages ? safePage + 1 : null,
    previous_page_number: safePage > 1 && safePage <= totalPages ? safePage - 1 : null,
    results,
  };
}

async function fetchTournamentRoundStandingsUnpaginated(roundId: number): Promise<StandingEntry[]> {
  const url = `${API_BASE}/tournament-rounds/${roundId}/standings/`;
  const response = await fetchWithRetry(url, { method: "GET", headers });
  if (!response.ok) return [];
  const payload = await response.json() as { standings?: StandingEntry[] };
  return payload.standings ?? [];
}

export async function fetchTournamentRoundMatches(
  roundId: number,
  page: number = 1,
  pageSize: number = 25
): Promise<MatchesResponse> {
  const url = new URL(`${API_BASE}/tournament-rounds/${roundId}/matches/paginated/`);
  url.searchParams.set("page", page.toString());
  url.searchParams.set("page_size", pageSize.toString());
  const response = await fetchWithRetry(url.toString(), { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

const STANDINGS_PAGE_SIZE = 100;
const STANDINGS_MAX_PAGES = 50;

/**
 * Fetch all pages of standings for a round. Cached with TTL for past events.
 */
export async function fetchAllRoundStandings(
  roundId: number,
  isPastEvent: boolean = false
): Promise<StandingEntry[]> {
  const cacheKey = String(roundId);
  const cached = roundStandingsFullCache.get(cacheKey);
  if (cached) return cached;

  const all: StandingEntry[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= STANDINGS_MAX_PAGES) {
    const response = await fetchTournamentRoundStandings(roundId, page, STANDINGS_PAGE_SIZE, { isPastEvent });
    all.push(...response.results);
    hasMore = response.next_page_number != null && response.results.length === STANDINGS_PAGE_SIZE;
    page += 1;
  }

  if (all.length > 0) {
    const ttl = isPastEvent ? CACHE_TTL_PAST_MS : CACHE_TTL_LIVE_MS;
    roundStandingsFullCache.set(cacheKey, all, ttl);
  }

  return all;
}

// ============================================================================
// Event standings (resolve latest round with data)
// ============================================================================

/** Priority for round order: prefer rounds with final standings (0 = highest priority). */
function roundStandingsPriority(standingsStatus: string | undefined): number {
  if (!standingsStatus) return 1;
  const s = standingsStatus.toLowerCase();
  if (s === "completed" || s === "final" || s === "published" || s === "closed") return 0;
  if (s === "pending" || s === "in_progress" || s === "in progress") return 2;
  return 1;
}

/**
 * Get event details and standings from the latest completed round that has data.
 * Tries rounds with final standings_status first, then newest-first by round_number.
 * Returns null if no standings are available.
 */
export async function getEventStandings(
  eventId: number,
  pageSize: number = 50
): Promise<{ event: Event; standings: StandingEntry[] } | null> {
  const event = await fetchEventDetails(eventId);
  const phases = event.tournament_phases;
  if (!phases?.length) return null;

  const isPast = isEventCompleted(event);
  const allRounds: {
    id: number;
    round_number: number;
    phase_index: number;
    standings_status?: string;
  }[] = [];

  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    if (!phase.rounds?.length) continue;
    for (const r of phase.rounds) {
      allRounds.push({
        id: r.id,
        round_number: r.round_number,
        phase_index: phaseIndex,
        standings_status: r.standings_status,
      });
    }
  }

  // Prefer rounds with final standings, then newest phase, then highest round number.
  allRounds.sort((a, b) => {
    const pa = roundStandingsPriority(a.standings_status);
    const pb = roundStandingsPriority(b.standings_status);
    if (pa !== pb) return pa - pb;
    if (b.phase_index !== a.phase_index) return b.phase_index - a.phase_index;
    return b.round_number - a.round_number;
  });

  for (const round of allRounds) {
    try {
      const standingsRes = await fetchTournamentRoundStandings(round.id, 1, pageSize, { isPastEvent: isPast });
      if (standingsRes.results.length > 0) {
        return { event, standings: standingsRes.results };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ============================================================================
// Batch standings (multiple events, bounded concurrency)
// ============================================================================

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

/** Max concurrent event-standing fetches. */
const EVENT_STANDINGS_CONCURRENCY = 8;

/** Fetch standings for multiple events with bounded concurrency; skips events with no standings. */
export async function fetchAllEventStandings(
  eventIds: number[]
): Promise<Array<{ event: Event; standings: StandingEntry[] }>> {
  const raw = await runWithBoundedConcurrency(
    eventIds,
    EVENT_STANDINGS_CONCURRENCY,
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
    if (one !== null && one !== undefined) {
      results.push(one);
    }
  }
  return results;
}

// ============================================================================
// Stores
// ============================================================================

export async function fetchStores(params: Record<string, string>): Promise<StoresResponse> {
  const url = new URL(`${API_BASE}/game-stores/`);
  url.searchParams.append("game_id", "1");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.append(key, value);
    }
  }
  const response = await fetchWithRetry(url.toString(), { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}

export async function fetchStoreDetails(storeId: string): Promise<GameStore> {
  const url = `${API_BASE}/game-stores/${encodeURIComponent(storeId)}/`;
  const response = await fetchWithRetry(url, { method: "GET", headers });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }
  return response.json();
}
