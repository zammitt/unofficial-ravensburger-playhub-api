/**
 * API client for Ravensburger Play (events, stores, formats, categories, standings, registrations).
 */

import type {
  Event,
  EventCategory,
  EventsResponse,
  GameplayFormat,
  GameStore,
  MatchesResponse,
  RegistrationsResponse,
  StandingEntry,
  StandingsResponse,
  StoresResponse,
} from "./types.js";
import { fetchWithRetry } from "./http.js";

const API_BASE = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2";
const DEBUG_API_LOGGING = /^(1|true|yes|on)$/i.test(process.env.LORCANA_MCP_DEBUG ?? "");

function debugApiLog(message: string): void {
  if (DEBUG_API_LOGGING) {
    console.error(message);
  }
}

/** Event statuses for tool schema. "all" expands to upcoming, inProgress, past when calling the API. */
export const STATUSES = ["upcoming", "inProgress", "past", "all"] as const;

const API_STATUSES = ["upcoming", "inProgress", "past"] as const;

/** Expand statuses for API: "all" or empty → [upcoming, inProgress, past]. Other values passed through. */
export function expandStatusesForApi(statuses: readonly string[]): string[] {
  if (statuses.length === 0 || statuses.includes("all")) return [...API_STATUSES];
  return statuses.filter((s) => s !== "all") as string[];
}

// Dynamic lookup maps - populated at startup and refreshed by list_filters
let FORMAT_MAP: Map<string, string> = new Map(); // name -> id
let CATEGORY_MAP: Map<string, string> = new Map(); // name -> id

// ============================================================================
// Caching for completed (past) events
// ============================================================================

/** Max entries for event cache (keyed by event_id). */
const EVENT_CACHE_MAX_SIZE = 500;

/** Max entries for round standings cache (keyed by round_id). */
const ROUND_STANDINGS_CACHE_MAX_SIZE = 1000;

/** Cache for completed event details (event_id -> Event). Only stores past events; never upcoming or in-progress. */
const eventCache = new Map<number, Event>();

/**
 * Cache for round standings (round_id -> StandingEntry[]).
 * Only stores rounds that belong to completed (past) events. Do not cache rounds for in-progress or future events.
 */
const roundStandingsCache = new Map<number, StandingEntry[]>();

/** Evict oldest entries from a Map if it exceeds maxSize. */
function evictIfNeeded<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size <= maxSize) return;
  // Map iteration order is insertion order; collect oldest keys then delete (avoid mutating during iteration)
  const toDelete = cache.size - maxSize;
  const keysToDelete: K[] = [];
  for (const key of cache.keys()) {
    if (keysToDelete.length >= toDelete) break;
    keysToDelete.push(key);
  }
  for (const key of keysToDelete) {
    cache.delete(key);
  }
}

/** Check if an event is completed (past). */
function isEventCompleted(event: Event): boolean {
  // API uses "past" for completed events in display_status
  // Also check settings.event_lifecycle_status as fallback
  const status = event.display_status?.toLowerCase();
  const lifecycle = event.settings?.event_lifecycle_status?.toLowerCase();
  return status === "past" || lifecycle === "completed" || lifecycle === "past";
}

/** Clear all caches. Useful for testing. */
export function clearCaches(): void {
  eventCache.clear();
  roundStandingsCache.clear();
}

/** Get cache statistics for debugging. */
export function getCacheStats(): { eventCacheSize: number; roundStandingsCacheSize: number } {
  return {
    eventCacheSize: eventCache.size,
    roundStandingsCacheSize: roundStandingsCache.size,
  };
}

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

export async function fetchGameplayFormats(): Promise<GameplayFormat[]> {
  const url = `${API_BASE}/gameplay-formats/?game_slug=disney-lorcana`;
  const response = await fetchWithRetry(url, {
    headers: { Referer: "https://tcg.ravensburgerplay.com/" },
  });
  if (!response.ok) throw new Error("Failed to fetch formats");
  return response.json();
}

export async function fetchCategories(): Promise<EventCategory[]> {
  const url = `${API_BASE}/event-configuration-templates/?game_slug=disney-lorcana`;
  const response = await fetchWithRetry(url, {
    headers: { Referer: "https://tcg.ravensburgerplay.com/" },
  });
  if (!response.ok) throw new Error("Failed to fetch categories");
  return response.json();
}

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

  const response = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://tcg.ravensburgerplay.com/",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const data = await response.json() as EventsResponse;
  debugApiLog(`[fetchEvents] Response: count=${data.count}, results=${data.results?.length ?? 0}`);
  return data;
}

export async function fetchEventDetails(eventId: number): Promise<Event> {
  // Check cache first
  const cached = eventCache.get(eventId);
  if (cached) {
    return cached;
  }

  const url = `${API_BASE}/events/${eventId}/`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://tcg.ravensburgerplay.com/",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const event = await response.json() as Event;

  // Cache completed events
  if (isEventCompleted(event)) {
    eventCache.set(eventId, event);
    evictIfNeeded(eventCache, EVENT_CACHE_MAX_SIZE);
  }

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

  const response = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://tcg.ravensburgerplay.com/",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json();
}

export async function fetchTournamentRoundStandings(
  roundId: number,
  page: number = 1,
  pageSize: number = 25
): Promise<StandingsResponse> {
  const url = new URL(`${API_BASE}/tournament-rounds/${roundId}/standings/paginated/`);
  url.searchParams.set("page", page.toString());
  url.searchParams.set("page_size", pageSize.toString());

  const response = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://tcg.ravensburgerplay.com/",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json();
}

export async function fetchTournamentRoundMatches(
  roundId: number,
  page: number = 1,
  pageSize: number = 25
): Promise<MatchesResponse> {
  const url = new URL(`${API_BASE}/tournament-rounds/${roundId}/matches/paginated/`);
  url.searchParams.set("page", page.toString());
  url.searchParams.set("page_size", pageSize.toString());

  const response = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://tcg.ravensburgerplay.com/",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json();
}

export async function fetchStores(params: Record<string, string>): Promise<StoresResponse> {
  const url = new URL(`${API_BASE}/game-stores/`);
  url.searchParams.append("game_id", "1");

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      url.searchParams.append(key, value);
    }
  }

  const response = await fetchWithRetry(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://tcg.ravensburgerplay.com/",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${text}`);
  }

  return response.json();
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

const STANDINGS_PAGE_SIZE = 100;

/** Safety limit: max pages per round to avoid infinite loop if API misbehaves. */
const STANDINGS_MAX_PAGES = 50;

/**
 * Fetch all pages of standings for a round.
 * Cache is used only when isPastEvent is true (round belongs to a completed event).
 * Do not cache rounds for in-progress or future events; isPastEvent must only be true when the parent event is past.
 */
export async function fetchAllRoundStandings(
  roundId: number,
  isPastEvent: boolean = false
): Promise<StandingEntry[]> {
  // Only read from cache for completed events
  if (isPastEvent) {
    const cached = roundStandingsCache.get(roundId);
    if (cached) return cached;
  }

  const all: StandingEntry[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore && page <= STANDINGS_MAX_PAGES) {
    const response = await fetchTournamentRoundStandings(roundId, page, STANDINGS_PAGE_SIZE);
    all.push(...response.results);
    hasMore = response.next_page_number != null && response.results.length === STANDINGS_PAGE_SIZE;
    page += 1;
  }

  // Only write to cache for completed events; never cache in-progress or future rounds
  if (isPastEvent && all.length > 0) {
    roundStandingsCache.set(roundId, all);
    evictIfNeeded(roundStandingsCache, ROUND_STANDINGS_CACHE_MAX_SIZE);
  }

  return all;
}

/** Get event details and all standings from the latest completed round that has data. Returns null if no standings. */
export async function getEventStandings(eventId: number): Promise<{ event: Event; standings: StandingEntry[] } | null> {
  const event = await fetchEventDetails(eventId);
  const phases = event.tournament_phases;
  if (!phases?.length) return null;

  // Only pass true for completed (past) events so we aggressively cache round standings for them and never for in-progress/future
  const isPast = isEventCompleted(event);
  const allRounds: { id: number; round_number: number; phase_index: number }[] = [];
  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    if (!phase.rounds?.length) continue;
    for (const r of phase.rounds) {
      allRounds.push({ id: r.id, round_number: r.round_number, phase_index: phaseIndex });
    }
  }
  // Prefer newest phase first, then highest round number within phase.
  allRounds.sort(
    (a, b) =>
      b.phase_index - a.phase_index ||
      b.round_number - a.round_number ||
      b.id - a.id
  );

  for (const round of allRounds) {
    try {
      const standings = await fetchAllRoundStandings(round.id, isPast);
      if (standings.length > 0) {
        return { event, standings };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Fetch standings for multiple events. Skips events that have no standings. */
export async function fetchAllEventStandings(
  eventIds: number[]
): Promise<Array<{ event: Event; standings: StandingEntry[] }>> {
  const results: Array<{ event: Event; standings: StandingEntry[] }> = [];
  for (const eventId of eventIds) {
    try {
      const one = await getEventStandings(eventId);
      if (one) results.push(one);
    } catch {
      // Skip failed events
    }
  }
  return results;
}
