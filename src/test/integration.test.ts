import assert from "node:assert";
import { describe, it } from "node:test";
import {
  // Core API
  expandStatusesForApi,
  fetchAllEventStandings,
  fetchAllRoundStandings,
  fetchCardById,
  fetchCategories,
  fetchEventDetails,
  fetchEventQuickFilters,
  fetchEventRegistrations,
  fetchEvents,
  fetchGameDetails,
  fetchGames,
  fetchGameplayFormats,
  fetchStoreDetails,
  fetchStores,
  fetchTournamentRoundMatches,
  fetchTournamentRoundStandings,
  geocodeAddress,
  geocodePlaceId,
  getEventStandings,
  searchCardsQuick,
  autocompletePlaces,
  // Search helpers
  searchEventsByCity,
  searchEventsByCoords,
  searchEventsByStore,
  searchStores,
  // Leaderboard
  getPlayerLeaderboardByCity,
  getPlayerLeaderboardByStore,
  // Formatting
  formatEventCompact,
  formatLeaderboard,
  formatLeaderboardEntry,
  formatStandingEntry,
  formatStoreCompact,
  // Types
  type Event,
  type StandingEntry,
} from "../index.js";

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

async function findEventWithRound(): Promise<{ eventId: number; roundId: number } | null> {
  const events = await fetchEvents({
    game_slug: "disney-lorcana",
    latitude: "39.8283",
    longitude: "-98.5795",
    num_miles: "12500",
    display_statuses: ["past", "inProgress", "upcoming"],
    page: "1",
    page_size: "15",
  });

  for (const event of events.results) {
    try {
      const details = await fetchEventDetails(event.id);
      const phases = details.tournament_phases ?? [];
      for (let i = phases.length - 1; i >= 0; i--) {
        const rounds = phases[i]?.rounds ?? [];
        if (rounds.length > 0) {
          const newestRound = rounds[rounds.length - 1];
          if (newestRound?.id) {
            return { eventId: details.id, roundId: newestRound.id };
          }
        }
      }
    } catch {
      // Continue scanning other events.
    }
  }

  return null;
}

// ============================================================================
// Core API tests
// ============================================================================

describe("Core API", { timeout: INTEGRATION_TIMEOUT_MS, concurrency: 1 }, () => {
  it("expands status aliases for API requests", () => {
    assert.deepStrictEqual(expandStatusesForApi(["all"]), ["upcoming", "inProgress", "past"]);
    assert.deepStrictEqual(expandStatusesForApi(["upcoming", "past"]), ["upcoming", "past"]);
  });

  it("fetches gameplay formats and categories", async () => {
    const [formats, categories] = await Promise.all([
      fetchGameplayFormats(),
      fetchCategories(),
    ]);
    assert.ok(Array.isArray(formats), "formats should be an array");
    assert.ok(Array.isArray(categories), "categories should be an array");
    if (formats.length > 0) {
      assert.ok(typeof formats[0]?.id === "string" && formats[0].id.length > 0, "format id should be present");
      assert.ok(typeof formats[0]?.name === "string" && formats[0].name.length > 0, "format name should be present");
    }
    if (categories.length > 0) {
      assert.ok(typeof categories[0]?.id === "string" && categories[0].id.length > 0, "category id should be present");
      assert.ok(typeof categories[0]?.name === "string" && categories[0].name.length > 0, "category name should be present");
    }
  });

  it("fetches quick filters plus games and game details", async () => {
    const [quickFilters, games] = await Promise.all([
      fetchEventQuickFilters("disney-lorcana"),
      fetchGames(),
    ]);
    assert.ok(Array.isArray(quickFilters), "quick filters should be an array");
    assert.ok(Array.isArray(games) && games.length > 0, "games should include at least one game");

    const targetGame = games.find((g) => g.slug === "disney-lorcana") ?? games[0];
    assert.ok(targetGame?.slug, "target game slug should be present");
    const details = await fetchGameDetails(targetGame.slug);
    assert.strictEqual(details.slug, targetGame.slug);
  });

  it("searches places and geocodes by address and place id", async (t) => {
    const byAddress = await geocodeAddress("Detroit, MI");
    assert.ok(byAddress, "geocodeAddress should return a result for Detroit, MI");
    assert.ok(typeof byAddress?.address.lat === "number", "address latitude should be numeric");
    assert.ok(typeof byAddress?.address.lng === "number", "address longitude should be numeric");

    const auto = await autocompletePlaces("Detroit, MI", `api-integration-${Date.now()}`);
    assert.ok(Array.isArray(auto.suggestions), "autocomplete suggestions should be an array");

    const placeId = auto.suggestions.find((s) => s.placePrediction?.placeId)?.placePrediction?.placeId;
    if (!placeId) {
      t.skip("No place_id returned by autocomplete");
      return;
    }

    const byPlaceId = await geocodePlaceId(placeId);
    assert.ok(byPlaceId, "geocodePlaceId should return a result");
    assert.ok(typeof byPlaceId?.address.lat === "number", "place latitude should be numeric");
    assert.ok(typeof byPlaceId?.address.lng === "number", "place longitude should be numeric");
  });

  it("searches cards and fetches card details", async (t) => {
    const cards = await searchCardsQuick("elsa", 1);
    assert.ok(typeof cards.count === "number", "card count should be numeric");
    assert.ok(Array.isArray(cards.results), "card results should be an array");

    if (cards.results.length === 0) {
      t.skip("No card results for query");
      return;
    }

    const card = await fetchCardById(cards.results[0].id);
    assert.strictEqual(card.id, cards.results[0].id);
    assert.ok(Boolean(card.display_name ?? card.name), "card name should be present");
  });

  it("searches stores and fetches store details", async (t) => {
    const stores = await fetchStores({ page: "1", page_size: "5", search: "game" });
    assert.ok(Array.isArray(stores.results), "store results should be an array");

    if (stores.results.length === 0) {
      t.skip("No stores returned for query");
      return;
    }

    const details = await fetchStoreDetails(stores.results[0].id);
    assert.strictEqual(details.id, stores.results[0].id);
    assert.ok(typeof details.store.name === "string" && details.store.name.length > 0, "store name should be present");
  });

  it("searches events, gets event details, and fetches registrations", async (t) => {
    const events = await fetchEvents({
      game_slug: "disney-lorcana",
      latitude: "39.8283",
      longitude: "-98.5795",
      num_miles: "12500",
      display_statuses: ["upcoming", "inProgress", "past"],
      page: "1",
      page_size: "5",
    });

    assert.ok(Array.isArray(events.results), "event results should be an array");
    if (events.results.length === 0) {
      t.skip("No events returned for broad search");
      return;
    }

    const eventId = events.results[0].id;
    const details = await fetchEventDetails(eventId);
    assert.strictEqual(details.id, eventId);

    const registrations = await fetchEventRegistrations(eventId, 1, 10);
    assert.ok(Array.isArray(registrations.results), "registration results should be an array");
    assert.ok(typeof registrations.total === "number", "registration total should be numeric");
  });

  it("fetches round standings and matches when a round exists", async (t) => {
    const found = await findEventWithRound();
    if (!found) {
      t.skip("No event with rounds found in sampled events");
      return;
    }

    const standings = await fetchTournamentRoundStandings(found.roundId, 1, 25);
    assert.ok(Array.isArray(standings.results), "round standings should be an array");
    assert.ok(typeof standings.total === "number", "standings total should be numeric");

    const allStandings = await fetchAllRoundStandings(found.roundId, false);
    assert.ok(Array.isArray(allStandings), "all round standings should be an array");

    const matches = await fetchTournamentRoundMatches(found.roundId, 1, 25);
    assert.ok(Array.isArray(matches.results), "round matches should be an array");
    assert.ok(typeof matches.total === "number", "matches total should be numeric");
  });

  it("aggregates event standings for one event", async (t) => {
    const found = await findEventWithRound();
    if (!found) {
      t.skip("No event with rounds found in sampled events");
      return;
    }

    const eventStandings = await getEventStandings(found.eventId);
    if (!eventStandings) {
      t.skip("No standings currently available for sampled event");
      return;
    }
    assert.strictEqual(eventStandings.event.id, found.eventId);
    assert.ok(Array.isArray(eventStandings.standings), "event standings should be an array");

    const many = await fetchAllEventStandings([found.eventId]);
    assert.ok(Array.isArray(many), "fetchAllEventStandings should return an array");
    assert.ok(many.length <= 1, "single event input should return at most one result");
    if (many.length === 1) {
      assert.strictEqual(many[0]?.event.id, found.eventId);
    }
  });
});

// ============================================================================
// Search helpers tests
// ============================================================================

describe("Search helpers", { timeout: INTEGRATION_TIMEOUT_MS, concurrency: 1 }, () => {
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

    const details = await fetchEventDetails(broad.events[0].id);
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

    const standings = await fetchTournamentRoundStandings(roundId, 1, 25);
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
    assert.strictEqual(eventStandings.event.id, details.id);
    assert.ok(Array.isArray(eventStandings.standings), "event standings should be an array");
  });
});

// ============================================================================
// Leaderboard tests
// ============================================================================

describe("Leaderboard", { timeout: INTEGRATION_TIMEOUT_MS, concurrency: 1 }, () => {
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
