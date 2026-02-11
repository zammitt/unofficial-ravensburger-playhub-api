# unofficial-ravensburger-playhub-api

Shared PlayHub API library used by:
- unofficial-ravensburger-playhub-mcp
- other PlayHub consumers

## Install

```bash
npm install unofficial-ravensburger-playhub-api
```

## Entry points

- `unofficial-ravensburger-playhub-api`: MCP-oriented API surface (events, stores, standings, filters)
- `unofficial-ravensburger-playhub-api/bot`: App-oriented API surface (search helpers + leaderboard + compact text formatting helpers)

## Build

```bash
npm run build
```

## Integration tests

```bash
# MCP-facing API surface
npm run test:integration:mcp

# Bot-facing API surface
npm run test:integration:bot

# Run both
npm test
```
