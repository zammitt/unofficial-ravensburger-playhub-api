# unofficial-ravensburger-playhub-api

Unofficial TypeScript client for the Ravensburger PlayHub API. Provides access to Disney Lorcana events, stores, standings, cards, and leaderboards.

> **Disclaimer:** This library depends on undocumented Ravensburger PlayHub API endpoints that may change or break without notice. It is not affiliated with or endorsed by Ravensburger.

## Install

```bash
npm install unofficial-ravensburger-playhub-api
```

## Entry points

- `unofficial-ravensburger-playhub-api`: Full API surface (events, stores, standings, filters, leaderboards, search helpers, formatting)

## Usage

```typescript
import {
  searchEvents,
  searchStores,
  getEventStandings,
} from "unofficial-ravensburger-playhub-api";

// Search for upcoming Lorcana events near a location
const events = await searchEvents({
  latitude: 41.8781,
  longitude: -87.6298,
  radiusKm: 50,
});

// Find stores that run Lorcana events
const stores = await searchStores({
  latitude: 41.8781,
  longitude: -87.6298,
  radiusKm: 25,
});

// Get standings for a specific event
const standings = await getEventStandings("event-id-here");
```

## Build

```bash
npm run build
```

## Integration tests

```bash
npm run test:integration
```
