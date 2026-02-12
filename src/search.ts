/**
 * Higher-level search helpers: find events and stores by city, coordinates, or store ID.
 * Wraps core API calls with Nominatim geocoding and TTL caching.
 */

import type { Event, GameStore, StoresResponse } from "./types.js";
import { fetchWithRetry } from "./http.js";
import { createTtlCache } from "./ttlCache.js";
import { geocodeCity } from "./geocode.js";
import { API_BASE, headers } from "./api.js";

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_SIZE = 1000;

// ============================================================================
// Shared result types
// ============================================================================

export interface EventSearchResult {
  events: Event[];
  location: string;
  total: number;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}

export interface StoreSearchResult {
  stores: GameStore[];
  total: number;
  location?: string;
  currentPage: number;
  nextPage: number | null;
  pageSize: number;
}

interface EventsApiResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  results: Event[];
}

// ============================================================================
// Caches
// ============================================================================

const eventsByCityCache = createTtlCache<EventSearchResult>({ maxSize: CACHE_MAX_SIZE });
const eventsByStoreCache = createTtlCache<EventSearchResult>({ maxSize: CACHE_MAX_SIZE });
const eventsByCoordsCache = createTtlCache<EventSearchResult>({ maxSize: CACHE_MAX_SIZE });
const storesSearchCache = createTtlCache<StoreSearchResult>({ maxSize: CACHE_MAX_SIZE });

// ============================================================================
// Events by city
// ============================================================================

export interface SearchEventsByCityParams {
  city: string;
  radiusMiles?: number;
  statuses?: ("upcoming" | "inProgress" | "past")[];
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  pageSize?: number;
  page?: number;
}

export async function searchEventsByCity(
  params: SearchEventsByCityParams
): Promise<EventSearchResult | { error: string }> {
  const {
    city,
    radiusMiles = 25,
    statuses = ["upcoming", "inProgress"],
    startDate,
    endDate,
    pageSize = 25,
    page = 1,
  } = params;

  const cacheKey = `eventsByCity:${[
    city.toLowerCase(), radiusMiles, statuses.join(","),
    startDate ?? "", endDate ?? "", pageSize, page,
  ].join("|")}`;
  const cached = eventsByCityCache.get(cacheKey);
  if (cached) return cached;

  const geo = await geocodeCity(city);
  if (!geo) return { error: `Could not find location: ${city}` };

  const query = new URLSearchParams();
  query.set("game_slug", "disney-lorcana");
  query.set("latitude", geo.lat.toString());
  query.set("longitude", geo.lon.toString());
  query.set("num_miles", radiusMiles.toString());
  query.set("page", page.toString());
  query.set("page_size", pageSize.toString());
  for (const status of statuses) query.append("display_statuses", status);
  if (startDate) query.set("start_date_after", `${startDate}T00:00:00Z`);
  if (endDate) query.set("start_date_before", `${endDate}T23:59:59Z`);

  const res = await fetchWithRetry(`${API_BASE}/events/?${query.toString()}`, { headers });
  if (!res.ok) return { error: `API error: ${res.status}` };

  const data = (await res.json()) as EventsApiResponse;
  const result: EventSearchResult = {
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

// ============================================================================
// Events by coordinates
// ============================================================================

export interface SearchEventsByCoordsParams {
  latitude: number;
  longitude: number;
  locationLabel?: string;
  radiusMiles?: number;
  statuses?: ("upcoming" | "inProgress" | "past")[];
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  page?: number;
}

export async function searchEventsByCoords(
  params: SearchEventsByCoordsParams
): Promise<EventSearchResult | { error: string }> {
  const {
    latitude, longitude, locationLabel,
    radiusMiles = 25,
    statuses = ["upcoming", "inProgress"],
    startDate, endDate,
    pageSize = 25, page = 1,
  } = params;

  const cacheKey = `eventsByCoords:${[
    latitude.toFixed(4), longitude.toFixed(4), radiusMiles,
    statuses.join(","), startDate ?? "", endDate ?? "", pageSize, page,
  ].join("|")}`;
  const cached = eventsByCoordsCache.get(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  query.set("game_slug", "disney-lorcana");
  query.set("latitude", latitude.toString());
  query.set("longitude", longitude.toString());
  query.set("num_miles", radiusMiles.toString());
  query.set("page", page.toString());
  query.set("page_size", pageSize.toString());
  for (const status of statuses) query.append("display_statuses", status);
  if (startDate) query.set("start_date_after", `${startDate}T00:00:00Z`);
  if (endDate) query.set("start_date_before", `${endDate}T23:59:59Z`);

  const res = await fetchWithRetry(`${API_BASE}/events/?${query.toString()}`, { headers });
  if (!res.ok) return { error: `API error: ${res.status}` };

  const data = (await res.json()) as EventsApiResponse;
  const result: EventSearchResult = {
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

// ============================================================================
// Events by store
// ============================================================================

export interface SearchEventsByStoreParams {
  storeId: number;
  storeLabel?: string;
  statuses?: ("upcoming" | "inProgress" | "past")[];
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  page?: number;
}

export async function searchEventsByStore(
  params: SearchEventsByStoreParams
): Promise<EventSearchResult | { error: string }> {
  const {
    storeId, storeLabel,
    statuses = ["upcoming", "inProgress"],
    startDate, endDate,
    pageSize = 25, page = 1,
  } = params;

  const cacheKey = `eventsByStore:${[
    storeId, storeLabel ?? "", statuses.join(","),
    startDate ?? "", endDate ?? "", pageSize, page,
  ].join("|")}`;
  const cached = eventsByStoreCache.get(cacheKey);
  if (cached) return cached;

  const query = new URLSearchParams();
  query.set("game_slug", "disney-lorcana");
  query.set("store_id", storeId.toString());
  query.set("page", page.toString());
  query.set("page_size", pageSize.toString());
  for (const status of statuses) query.append("display_statuses", status);
  if (startDate) query.set("start_date_after", `${startDate}T00:00:00Z`);
  if (endDate) query.set("start_date_before", `${endDate}T23:59:59Z`);

  const res = await fetchWithRetry(`${API_BASE}/events/?${query.toString()}`, { headers });
  if (!res.ok) return { error: `API error: ${res.status}` };

  const data = (await res.json()) as EventsApiResponse;
  const location = storeLabel || data.results[0]?.store?.name || `Store ${storeId}`;
  const result: EventSearchResult = {
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

// ============================================================================
// Stores
// ============================================================================

export interface SearchStoresParams {
  query?: string;
  city?: string;
  radiusMiles?: number;
  pageSize?: number;
  page?: number;
}

export async function searchStores(
  params: SearchStoresParams
): Promise<StoreSearchResult | { error: string }> {
  const { query, city, radiusMiles = 50, pageSize = 25, page = 1 } = params;

  const cacheKey = `stores:${[
    query?.toLowerCase() ?? "", city?.toLowerCase() ?? "",
    radiusMiles, pageSize, page,
  ].join("|")}`;
  const cached = storesSearchCache.get(cacheKey);
  if (cached) return cached;

  const urlParams = new URLSearchParams();
  urlParams.set("game_id", "1");
  urlParams.set("page", page.toString());
  urlParams.set("page_size", pageSize.toString());
  if (query) urlParams.set("search", query);

  let locationName: string | undefined;
  if (city) {
    const geo = await geocodeCity(city);
    if (!geo) return { error: `Could not find location: ${city}` };
    urlParams.set("latitude", geo.lat.toString());
    urlParams.set("longitude", geo.lon.toString());
    urlParams.set("num_miles", radiusMiles.toString());
    locationName = geo.display_name;
  }

  const res = await fetchWithRetry(`${API_BASE}/game-stores/?${urlParams.toString()}`, { headers });
  if (!res.ok) return { error: `API error: ${res.status}` };

  const data = (await res.json()) as StoresResponse;
  const result: StoreSearchResult = {
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
