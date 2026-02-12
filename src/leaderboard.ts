/**
 * Player leaderboard aggregation across multiple events.
 */

import type { Event, StandingEntry, PlayerStats, LeaderboardResult } from "./types.js";
import { getEventStandings, fetchAllEventStandings } from "./api.js";
import { searchEventsByCoords, searchEventsByStore } from "./search.js";
import { geocodeCity } from "./geocode.js";

export const MAX_LEADERBOARD_DATE_RANGE_DAYS = 366;
export const MAX_LEADERBOARD_RADIUS_MILES = 100;
export const MAX_LEADERBOARD_LIMIT = 100;

export type LeaderboardSortBy =
  | "total_wins"
  | "events_played"
  | "win_rate"
  | "best_placement";

// ============================================================================
// Leaderboard by city
// ============================================================================

export interface GetPlayerLeaderboardByCityParams {
  city: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  radiusMiles?: number;
  limit?: number;
  minEvents?: number;
  minRounds?: number;
  sortBy?: LeaderboardSortBy;
}

export async function getPlayerLeaderboardByCity(
  params: GetPlayerLeaderboardByCityParams
): Promise<LeaderboardResult | { error: string }> {
  const {
    city, startDate, endDate,
    radiusMiles = 50, limit = 20, minEvents = 1,
    minRounds, sortBy = "total_wins",
  } = params;

  const dateError = validateDateRange(startDate, endDate);
  if (dateError) return { error: dateError };

  const radius = Math.min(MAX_LEADERBOARD_RADIUS_MILES, Math.max(0, radiusMiles));
  const limitCap = Math.min(MAX_LEADERBOARD_LIMIT, Math.max(1, limit));
  const minEventsCap = Math.max(1, minEvents);

  const geo = await geocodeCity(city);
  if (!geo) return { error: `Could not find location: ${city}` };

  const allEvents: Array<{ id: number; name: string; start_datetime: string }> = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const result = await searchEventsByCoords({
      latitude: geo.lat, longitude: geo.lon,
      locationLabel: geo.display_name,
      radiusMiles: radius,
      statuses: ["past", "inProgress"],
      startDate, endDate,
      pageSize: 100, page,
    });
    if ("error" in result) return result;
    for (const e of result.events) {
      allEvents.push({ id: e.id, name: e.name, start_datetime: e.start_datetime });
    }
    hasMore = result.events.length === 100 && result.total > allEvents.length;
    page += 1;
  }

  if (allEvents.length === 0) {
    return {
      error: `No past or in-progress events found near ${geo.display_name} for ${startDate} – ${endDate}. Try a larger radius or different dates.`,
    };
  }

  const eventStandings = await fetchAllEventStandings(allEvents.map((e) => e.id));
  const filteredStandings = filterByMinRounds(eventStandings, minRounds);
  const players = aggregateStandingsToPlayers(filteredStandings, minEventsCap, sortBy, limitCap);

  return {
    players,
    eventsAnalyzed: filteredStandings.length,
    eventsIncluded: filteredStandings.map(({ event }) => ({
      id: event.id,
      name: event.name,
      startDate: event.start_datetime.slice(0, 10),
    })),
    dateRange: { start: startDate, end: endDate },
    filters: { city: geo.display_name, ...(minRounds ? { minRounds } : {}) },
  };
}

// ============================================================================
// Leaderboard by store
// ============================================================================

export interface GetPlayerLeaderboardByStoreParams {
  storeId: number;
  storeLabel?: string;
  startDate: string;
  endDate: string;
  limit?: number;
  minEvents?: number;
  minRounds?: number;
  sortBy?: LeaderboardSortBy;
}

export async function getPlayerLeaderboardByStore(
  params: GetPlayerLeaderboardByStoreParams
): Promise<LeaderboardResult | { error: string }> {
  const {
    storeId, storeLabel, startDate, endDate,
    limit = 20, minEvents = 1, minRounds, sortBy = "total_wins",
  } = params;

  const dateError = validateDateRange(startDate, endDate);
  if (dateError) return { error: dateError };

  const limitCap = Math.min(MAX_LEADERBOARD_LIMIT, Math.max(1, limit));
  const minEventsCap = Math.max(1, minEvents);

  const allEvents: Array<{ id: number; name: string; start_datetime: string }> = [];
  let page = 1;
  let hasMore = true;
  let resolvedStoreLabel = storeLabel;
  while (hasMore) {
    const result = await searchEventsByStore({
      storeId, storeLabel: resolvedStoreLabel,
      statuses: ["past", "inProgress"],
      startDate, endDate,
      pageSize: 100, page,
    });
    if ("error" in result) return result;
    for (const e of result.events) {
      allEvents.push({ id: e.id, name: e.name, start_datetime: e.start_datetime });
      if (!resolvedStoreLabel && e.store?.name) resolvedStoreLabel = e.store.name;
    }
    hasMore = result.events.length === 100 && result.total > allEvents.length;
    page += 1;
  }

  if (allEvents.length === 0) {
    return {
      error: `No past or in-progress events found at store ${storeId} for ${startDate} – ${endDate}. Try different dates.`,
    };
  }

  const eventStandings = await fetchAllEventStandings(allEvents.map((e) => e.id));
  const filteredStandings = filterByMinRounds(eventStandings, minRounds);
  const players = aggregateStandingsToPlayers(filteredStandings, minEventsCap, sortBy, limitCap);

  return {
    players,
    eventsAnalyzed: filteredStandings.length,
    eventsIncluded: filteredStandings.map(({ event }) => ({
      id: event.id,
      name: event.name,
      startDate: event.start_datetime.slice(0, 10),
    })),
    dateRange: { start: startDate, end: endDate },
    filters: { store: resolvedStoreLabel ?? `Store ${storeId}`, ...(minRounds ? { minRounds } : {}) },
  };
}

// ============================================================================
// Internals
// ============================================================================

function validateDateRange(startDate: string, endDate: string): string | null {
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T23:59:59Z");
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return "Dates must be valid YYYY-MM-DD.";
  if (start > end) return "start_date must be on or before end_date.";
  const daysDiff = Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  if (daysDiff > MAX_LEADERBOARD_DATE_RANGE_DAYS) {
    return `Date range cannot exceed ${MAX_LEADERBOARD_DATE_RANGE_DAYS} days (about 1 year).`;
  }
  return null;
}

function filterByMinRounds(
  eventStandings: Array<{ event: Event; standings: StandingEntry[] }>,
  minRounds: number | undefined
): Array<{ event: Event; standings: StandingEntry[] }> {
  if (!minRounds) return eventStandings;
  return eventStandings.filter(({ event }) => {
    const totalRounds = (event.tournament_phases ?? []).reduce(
      (sum, phase) => sum + (phase.rounds?.length ?? 0), 0
    );
    return totalRounds >= minRounds;
  });
}

function parseRecordToWinsLosses(record: string | undefined): { wins: number; losses: number } {
  if (typeof record !== "string" || !record.trim()) return { wins: 0, losses: 0 };
  const parts = record.split("-").map((s) => parseInt(s.trim(), 10));
  if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return { wins: parts[0], losses: parts[1] };
  }
  return { wins: 0, losses: 0 };
}

/**
 * Stable key for aggregating a player across events.
 * Uses player.id when available (most stable), otherwise falls back to player.best_identifier.
 */
function standingPlayerKey(entry: StandingEntry): string {
  if (entry.player?.id !== undefined && entry.player.id !== null) {
    return `player_id:${entry.player.id}`;
  }
  return (
    entry.player?.best_identifier ??
    entry.player_name ??
    entry.display_name ??
    entry.username ??
    "—"
  );
}

function standingPlayerDisplayName(entry: StandingEntry): string {
  return (
    entry.user_event_status?.best_identifier ??
    entry.player?.best_identifier ??
    entry.player_name ??
    entry.display_name ??
    entry.username ??
    "—"
  );
}

function standingPlacement(entry: StandingEntry, index: number): number {
  return entry.rank ?? entry.placement ?? index + 1;
}

function standingWinsLosses(entry: StandingEntry): { wins: number; losses: number } {
  if (entry.wins !== undefined && entry.wins !== null && entry.losses !== undefined && entry.losses !== null) {
    return { wins: Number(entry.wins), losses: Number(entry.losses) };
  }
  return parseRecordToWinsLosses(entry.record ?? entry.match_record);
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
      if (key === "—") continue;
      const displayName = standingPlayerDisplayName(entry);
      const hasUserEventStatus = entry.user_event_status?.best_identifier !== undefined;
      const placement = standingPlacement(entry, i);
      const { wins, losses } = standingWinsLosses(entry);
      let rec = agg.get(key);
      if (!rec) {
        rec = { displayName, hasUserEventStatus, wins: 0, losses: 0, eventsPlayed: 0, placements: [] };
        agg.set(key, rec);
      } else if (hasUserEventStatus && !rec.hasUserEventStatus) {
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

  players = sortPlayers(players, sortBy);
  return players.slice(0, limit);
}

function sortPlayers(players: PlayerStats[], sortBy: LeaderboardSortBy): PlayerStats[] {
  const sorted = [...players];
  if (sortBy === "total_wins") {
    sorted.sort((a, b) => {
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return a.bestPlacement - b.bestPlacement;
    });
  } else if (sortBy === "events_played") {
    sorted.sort((a, b) => {
      if (b.eventsPlayed !== a.eventsPlayed) return b.eventsPlayed - a.eventsPlayed;
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return a.bestPlacement - b.bestPlacement;
    });
  } else if (sortBy === "win_rate") {
    sorted.sort((a, b) => {
      const rateA = a.totalWins + a.totalLosses > 0 ? a.totalWins / (a.totalWins + a.totalLosses) : 0;
      const rateB = b.totalWins + b.totalLosses > 0 ? b.totalWins / (b.totalWins + b.totalLosses) : 0;
      if (rateB !== rateA) return rateB - rateA;
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return a.bestPlacement - b.bestPlacement;
    });
  } else {
    sorted.sort((a, b) => {
      if (a.bestPlacement !== b.bestPlacement) return a.bestPlacement - b.bestPlacement;
      if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
      if (a.totalLosses !== b.totalLosses) return a.totalLosses - b.totalLosses;
      return 0;
    });
  }
  return sorted;
}
