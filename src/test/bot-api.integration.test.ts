import assert from "node:assert";
import { describe, it } from "node:test";
import {
  formatEventCompact,
  formatLeaderboard,
  formatLeaderboardEntry,
  formatStandingEntry,
  formatStoreCompact,
  getEventDetails,
  getEventStandings,
  getPlayerLeaderboardByCity,
  getPlayerLeaderboardByStore,
  getTournamentRoundStandings,
  searchEventsByCity,
  searchEventsByCoords,
  searchEventsByStore,
  searchStores,
  type Event,
  type StandingEntry,
} from "../bot/index.js";

const parsedTimeout = Number.parseInt(process.env.INTEGRATION_TEST_TIMEOUT_MS ?? "", 10);
const INTEGRATION_TIMEOUT_MS = Number.isFinite(parsedTimeout) && parsedTimeout > 0
  ? parsedTimeout
  : 300_000;

function isErrorResult(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function hasRounds(event: Event): boolean {
  const phases = event.tournament_phases ?? [];
  return phases.some((phase) => (phase.rounds?.length ?? 0) > 0);
}

function latestRoundId(event: Event): number | null {
  const phases = event.tournament_phases ?? [];
  for (let phaseIndex = phases.length - 1; phaseIndex >= 0; phaseIndex--) {
    const rounds = phases[phaseIndex]?.rounds ?? [];
    if (rounds.length > 0) {
      return rounds[rounds.length - 1]?.id ?? null;
    }
  }
  return null;
}

describe("PlayHub bot API integration", { timeout: INTEGRATION_TIMEOUT_MS, concurrency: 1 }, () => {
  it("searches stores and formats compact output", async (t) => {
    const stores = await searchStores({ query: "game", pageSize: 5, page: 1 });
    if (isErrorResult(stores)) {
      assert.fail(`searchStores failed: ${stores.error}`);
      return;
    }

    assert.ok(Array.isArray(stores.stores), "stores should be an array");
    if (stores.stores.length === 0) {
      t.skip("No stores returned");
      return;
    }

    const compact = formatStoreCompact(stores.stores[0]);
    assert.ok(compact.includes("•"), "compact store formatting should include list bullet");
  });

  it("searches events by coords, city, and store", async () => {
    const byCoords = await searchEventsByCoords({
      latitude: 39.8283,
      longitude: -98.5795,
      radiusMiles: 12500,
      statuses: ["upcoming", "inProgress", "past"],
      pageSize: 5,
      page: 1,
    });
    if (isErrorResult(byCoords)) {
      assert.fail(`searchEventsByCoords failed: ${byCoords.error}`);
      return;
    }
    assert.ok(Array.isArray(byCoords.events), "events by coords should be an array");

    const byCity = await searchEventsByCity({
      city: "Detroit, MI",
      radiusMiles: 25,
      statuses: ["upcoming", "inProgress"],
      pageSize: 5,
      page: 1,
    });
    if (isErrorResult(byCity)) {
      assert.fail(`searchEventsByCity failed: ${byCity.error}`);
      return;
    }
    assert.ok(Array.isArray(byCity.events), "events by city should be an array");

    const byStore = await searchEventsByStore({
      storeId: 4622,
      statuses: ["upcoming", "inProgress", "past"],
      pageSize: 5,
      page: 1,
    });
    if (isErrorResult(byStore)) {
      assert.fail(`searchEventsByStore failed: ${byStore.error}`);
      return;
    }
    assert.ok(Array.isArray(byStore.events), "events by store should be an array");
  });

  it("fetches event details, standings, and formats compact text", async (t) => {
    const broad = await searchEventsByCoords({
      latitude: 39.8283,
      longitude: -98.5795,
      radiusMiles: 12500,
      statuses: ["past", "inProgress", "upcoming"],
      pageSize: 10,
      page: 1,
    });
    if (isErrorResult(broad)) {
      assert.fail(`searchEventsByCoords failed: ${broad.error}`);
      return;
    }
    if (broad.events.length === 0) {
      t.skip("No events returned for broad query");
      return;
    }

    const details = await getEventDetails(broad.events[0].id);
    if (isErrorResult(details)) {
      assert.fail(`getEventDetails failed: ${details.error}`);
      return;
    }

    assert.strictEqual(details.id, broad.events[0].id);
    const eventLine = formatEventCompact(details);
    assert.ok(eventLine.includes("•"), "compact event formatting should include list bullet");

    if (!hasRounds(details)) {
      const noRounds = await getEventStandings(details.id);
      assert.strictEqual(noRounds, null, "getEventStandings should return null when no rounds exist");
      return;
    }

    const roundId = latestRoundId(details);
    if (!roundId) {
      t.skip("Event has phases but no round id found");
      return;
    }

    const standings = await getTournamentRoundStandings(roundId, 1, 25);
    if (isErrorResult(standings)) {
      assert.fail(`getTournamentRoundStandings failed: ${standings.error}`);
      return;
    }
    assert.ok(Array.isArray(standings.results), "standings results should be an array");

    if (standings.results.length > 0) {
      const line = formatStandingEntry(standings.results[0] as StandingEntry, 0);
      assert.ok(line.includes("1.") || line.includes("Record"), "standing formatting should include rank/record content");
    }

    const eventStandings = await getEventStandings(details.id);
    if (eventStandings === null) {
      t.skip("No event standings currently available");
      return;
    }
    if (isErrorResult(eventStandings)) {
      assert.fail(`getEventStandings failed: ${eventStandings.error}`);
      return;
    }
    assert.strictEqual(eventStandings.event.id, details.id);
    assert.ok(Array.isArray(eventStandings.standings), "event standings should be an array");
  });

  it("builds leaderboards for city and store plus formatting", async () => {
    const invalidDates = await getPlayerLeaderboardByCity({
      city: "Detroit, MI",
      startDate: "2026-02-01",
      endDate: "2026-01-01",
    });
    assert.ok(isErrorResult(invalidDates), "invalid date range should return an error");
    if (isErrorResult(invalidDates)) {
      assert.ok(invalidDates.error.includes("start_date"), "invalid date message should mention date ordering");
    }

    const byCity = await getPlayerLeaderboardByCity({
      city: "Detroit, MI",
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      limit: 5,
      minEvents: 1,
      sortBy: "total_wins",
    });
    if (isErrorResult(byCity)) {
      assert.ok(
        byCity.error.includes("No past or in-progress events found near"),
        `unexpected city leaderboard error: ${byCity.error}`
      );
    } else {
      assert.ok(Array.isArray(byCity.players), "city leaderboard players should be an array");
      const text = formatLeaderboard(byCity, "TOTAL WINS");
      assert.ok(text.includes("Player Leaderboard"), "formatted leaderboard should include title");
      if (byCity.players.length > 0) {
        const row = formatLeaderboardEntry(byCity.players[0], 1);
        assert.ok(row.includes("1."), "formatted leaderboard row should include rank");
      }
    }

    const byStore = await getPlayerLeaderboardByStore({
      storeId: 4622,
      startDate: "2025-01-01",
      endDate: "2025-01-31",
      limit: 5,
      minEvents: 1,
      sortBy: "total_wins",
    });
    if (isErrorResult(byStore)) {
      assert.ok(
        byStore.error.includes("No past or in-progress events found at store"),
        `unexpected store leaderboard error: ${byStore.error}`
      );
    } else {
      assert.ok(Array.isArray(byStore.players), "store leaderboard players should be an array");
      const text = formatLeaderboard(byStore, "TOTAL WINS");
      assert.ok(text.includes("Player Leaderboard"), "formatted leaderboard should include title");
    }
  });
});
