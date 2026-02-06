/**
 * Shared types for the Lorcana Event Finder MCP server (API responses and domain models).
 */

export interface GameplayFormat {
  id: string;
  name: string;
  description?: string;
}

export interface EventCategory {
  id: string;
  name: string;
}

export interface Store {
  id: number;
  name: string;
  full_address?: string;
  city?: string | null;
  state?: string | null;
  country?: string;
  latitude?: number;
  longitude?: number;
  website?: string;
  email?: string;
  phone_number?: string;
  street_address?: string;
  zipcode?: string;
  bio?: string | null;
  discord_url?: string;
  facebook_url?: string;
  twitter_handle?: string;
  instagram_handle?: string;
}

export interface GameStore {
  id: string;
  store: Store;
  store_types: string[];
  store_types_pretty: string[];
}

export interface StoresResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  previous_page_number: number | null;
  results: GameStore[];
}

/** A single tournament round (from event details). */
export interface TournamentRound {
  id: number;
  round_number: number;
  status?: string;
  standings_status?: string;
  [key: string]: unknown;
}

/** A tournament phase containing rounds (e.g. Swiss, Top Cut). */
export interface TournamentPhase {
  id: number;
  phase_name?: string;
  status?: string;
  rounds: TournamentRound[];
  [key: string]: unknown;
}

export interface Event {
  id: number;
  name: string;
  description?: string;
  start_datetime: string;
  end_datetime?: string | null;
  full_address?: string;
  latitude?: number;
  longitude?: number;
  gameplay_format?: GameplayFormat | null;
  event_configuration_template?: string;
  event_format?: string;
  event_type?: string;
  cost_in_cents?: number;
  currency?: string;
  capacity?: number;
  registered_user_count?: number;
  starting_player_count?: number;
  display_status?: string;
  is_headlining_event?: boolean;
  event_is_online?: boolean;
  distance_in_miles?: number;
  store?: Store;
  url?: string | null;
  settings?: {
    event_lifecycle_status?: string;
  };
  /** Tournament phases and rounds (when event has rounds). Use round IDs with get_tournament_round_standings. */
  tournament_phases?: TournamentPhase[];
}

export interface EventsResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  previous_page_number: number | null;
  results: Event[];
}

/** Tournament round standings (paginated). */
export interface StandingEntry {
  rank?: number;
  placement?: number;
  /** API often returns name under player.best_identifier */
  player?: { best_identifier?: string; id?: number; [key: string]: unknown };
  player_name?: string;
  username?: string;
  display_name?: string;
  wins?: number;
  losses?: number;
  /** API returns e.g. "3-0-1" */
  record?: string;
  match_record?: string;
  match_points?: number;
  opponent_match_win_pct?: number;
  opponent_match_win_percentage?: number;
  game_win_pct?: number;
  game_win_percentage?: number;
  /** Display name/username when available; prefer over player.best_identifier */
  user_event_status?: {
    best_identifier?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StandingsResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  previous_page_number: number | null;
  results: StandingEntry[];
}

/** A player in a match (from round matches API). */
export interface PlayerMatchRelationship {
  id?: number;
  player_order?: number;
  player?: { id?: number; best_identifier?: string; [key: string]: unknown };
  /** Display name/username when available; prefer over player.best_identifier */
  user_event_status?: {
    best_identifier?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A single match in a tournament round (pairing + result). */
export interface RoundMatchEntry {
  id?: number;
  status?: string;
  table_number?: number;
  winning_player?: number | null;
  games_won_by_winner?: number;
  games_won_by_loser?: number;
  match_is_bye?: boolean;
  match_is_intentional_draw?: boolean;
  match_is_unintentional_draw?: boolean;
  player_match_relationships?: PlayerMatchRelationship[];
  players?: number[];
  [key: string]: unknown;
}

export interface MatchesResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  previous_page_number: number | null;
  results: RoundMatchEntry[];
}

/** Event registrations (paginated). */
export interface RegistrationEntry {
  id?: number;
  /** API uses best_identifier for display name (e.g. "Corey J", "Corex"). */
  best_identifier?: string;
  user?: {
    username?: string;
    display_name?: string;
    first_name?: string;
    last_name?: string;
    best_identifier?: string;
    [key: string]: unknown;
  };
  display_name?: string;
  username?: string;
  status?: string;
  registration_status?: string;
  registered_at?: string;
  registration_completed_datetime?: string;
  [key: string]: unknown;
}

export interface RegistrationsResponse {
  count: number;
  total: number;
  page_size: number;
  current_page_number: number;
  next_page_number: number | null;
  previous_page_number: number | null;
  results: RegistrationEntry[];
}

/** Aggregated stats for one player across multiple events (leaderboard). */
export interface PlayerStats {
  playerName: string;
  totalWins: number;
  totalLosses: number;
  eventsPlayed: number;
  bestPlacement: number;
  /** Number of events where the player finished 1st. */
  firstPlaceFinishes: number;
  placements: number[];
}

/** Result of get_player_leaderboard aggregation. */
export interface LeaderboardResult {
  players: PlayerStats[];
  eventsAnalyzed: number;
  eventsIncluded: Array<{ id: number; name: string; startDate: string }>;
  dateRange: { start: string; end: string };
  filters?: { city?: string; store?: string; categories?: string[]; formats?: string[] };
}
