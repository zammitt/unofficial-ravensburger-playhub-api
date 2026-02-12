/**
 * Text formatting helpers for events, stores, standings, and leaderboards.
 */

import type { Event, GameStore, StandingEntry, PlayerStats, LeaderboardResult } from "./types.js";

const PLAYHUB_EVENT_URL = "https://tcg.ravensburgerplay.com/events";

type TimestampMarkupStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

function toTimestampMarkup(date: Date | string, style: TimestampMarkupStyle = "f"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const unixSeconds = Math.floor(d.getTime() / 1000);
  return `<t:${unixSeconds}:${style}>`;
}

/** Format event as compact one-liner text. */
export function formatEventCompact(event: Event): string {
  const link = `[${event.name}](<${PLAYHUB_EVENT_URL}/${event.id}>)`;
  const dateTime = toTimestampMarkup(event.start_datetime, "f");
  const store = event.store?.name || "";

  let fee = "Free";
  if (event.cost_in_cents && event.cost_in_cents > 0) {
    const dollars = event.cost_in_cents / 100;
    fee = `$${dollars.toFixed(2)}`;
  }

  const parts = [link, dateTime];
  if (store) parts.push(`@ ${store}`);
  parts.push(fee);

  return `• ${parts.join(" – ")}`;
}

/** Format store as compact one-liner text. */
export function formatStoreCompact(gameStore: GameStore): string {
  const store = gameStore.store;
  const parts: string[] = [`**${store.name}**`];

  const location: string[] = [];
  if (store.city) location.push(store.city);
  if (store.state) location.push(store.state);
  if (location.length > 0) {
    parts.push(location.join(", "));
  } else if (store.full_address) {
    parts.push(store.full_address);
  }

  const distance = gameStore.distance_in_miles ?? store.distance_in_miles;
  if (distance !== undefined && typeof distance === "number") {
    parts.push(`${distance.toFixed(1)} mi`);
  }

  if (store.website) {
    const url = store.website.startsWith("http") ? store.website : `https://${store.website}`;
    parts.push(`[Website](<${url}>)`);
  }

  return `• ${parts.join(" – ")}`;
}

/** Format a single standing entry (rank, name, record, optional OMWP/GWP). */
export function formatStandingEntry(entry: StandingEntry, index: number): string {
  const rank = entry.rank ?? entry.placement ?? index + 1;
  const name =
    entry.user_event_status?.best_identifier ??
    entry.player?.best_identifier ??
    entry.player_name ??
    entry.display_name ??
    entry.username ??
    "—";
  const lines: string[] = [`${rank}. ${name}`];

  const record =
    entry.record ??
    entry.match_record ??
    (entry.wins !== undefined || entry.losses !== undefined
      ? `${entry.wins ?? 0}-${entry.losses ?? 0}`
      : undefined);
  if (record) lines.push(`   Record: ${record}`);
  if (entry.match_points !== undefined) lines.push(`   Match points: ${entry.match_points}`);

  const omwp = entry.opponent_match_win_pct ?? entry.opponent_match_win_percentage;
  if (omwp !== undefined) lines.push(`   OMWP: ${(Number(omwp) * 100).toFixed(1)}%`);

  const gwp = entry.game_win_pct ?? entry.game_win_percentage;
  if (gwp !== undefined) lines.push(`   GWP: ${(Number(gwp) * 100).toFixed(1)}%`);

  return lines.join("\n");
}

/** Format one leaderboard row as a single compact line. */
export function formatLeaderboardEntry(entry: PlayerStats, rank: number): string {
  const winRate =
    entry.totalWins + entry.totalLosses > 0
      ? ((entry.totalWins / (entry.totalWins + entry.totalLosses)) * 100).toFixed(1)
      : "—";
  const ord =
    entry.bestPlacement === 1 ? "st"
    : entry.bestPlacement === 2 ? "nd"
    : entry.bestPlacement === 3 ? "rd"
    : "th";
  const eventLabel = entry.eventsPlayed === 1 ? "event" : "events";
  return `${rank}. ${entry.playerName} — ${entry.totalWins}W-${entry.totalLosses}L · ${entry.eventsPlayed} ${eventLabel} · ${winRate}% · Best ${entry.bestPlacement}${ord}`;
}

/** Build full leaderboard text. */
export function formatLeaderboard(result: LeaderboardResult, sortLabel: string): string {
  const lines: string[] = [];

  const filterParts: string[] = [];
  if (result.filters?.city) filterParts.push(`near ${result.filters.city}`);
  if (result.filters?.store) filterParts.push(`at ${result.filters.store}`);
  if (result.filters?.minRounds) filterParts.push(`min ${result.filters.minRounds} rounds`);
  const filterStr = filterParts.length > 0 ? ` (${filterParts.join(" | ")})` : "";

  lines.push(`**Player Leaderboard**${filterStr}`);
  lines.push(`Period: ${result.dateRange.start} – ${result.dateRange.end} · Events analyzed: ${result.eventsAnalyzed}`);
  lines.push("");
  lines.push(`🏆 Top by ${sortLabel}`);
  lines.push("");

  for (let i = 0; i < result.players.length; i++) {
    lines.push(formatLeaderboardEntry(result.players[i], i + 1));
  }

  if (result.eventsIncluded.length > 0) {
    lines.push("");
    lines.push("Events included:");
    const maxEventsShown = 10;
    for (const e of result.eventsIncluded.slice(0, maxEventsShown)) {
      const link = `[${e.name}](<${PLAYHUB_EVENT_URL}/${e.id}>)`;
      lines.push(`• ${link} — ${e.startDate}`);
    }
    if (result.eventsIncluded.length > maxEventsShown) {
      lines.push(`• … and ${result.eventsIncluded.length - maxEventsShown} more`);
    }
  }

  return lines.join("\n");
}
