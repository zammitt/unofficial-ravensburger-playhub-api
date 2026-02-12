/**
 * Shared geocoding via OpenStreetMap Nominatim with in-memory TTL cache.
 * Single implementation used by search helpers and digest subscriptions
 * to avoid duplicate rate-limited calls and inconsistent behavior.
 */

import { fetchWithRetry } from './http.js';
import { createTtlCache } from './ttlCache.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const GEO_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Max geocode entries to avoid unbounded memory growth; LRU eviction. */
const GEO_CACHE_MAX_SIZE = 500;

const geocodeCache = createTtlCache<GeocodeCityResult>({ maxSize: GEO_CACHE_MAX_SIZE });

export interface GeocodeCityResult {
  lat: number;
  lon: number;
  display_name: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

/**
 * Geocode a city/place name to coordinates using Nominatim.
 * Results are cached for 10 minutes to respect rate limits and avoid duplicate calls.
 */
export async function geocodeCity(
  city: string
): Promise<GeocodeCityResult | null> {
  const cacheKey = `geocode:${city.toLowerCase()}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached) return cached;

  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(city)}&format=json&limit=1`;
  const res = await fetchWithRetry(url, {
    headers: { 'User-Agent': 'lorcana-playhub-api/1.0' },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as NominatimResult[];
  if (!data.length) return null;

  const result: GeocodeCityResult = {
    lat: parseFloat(data[0]!.lat),
    lon: parseFloat(data[0]!.lon),
    display_name: data[0]!.display_name,
  };
  geocodeCache.set(cacheKey, result, GEO_CACHE_TTL_MS);
  return result;
}
