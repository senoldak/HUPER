export interface BotRow {
  id: string; name: string; strategy: string; symbol: string;
  params: string; status: string; state: string;
  created_at: number; updated_at: number;
}
export interface RunRow {
  id: string; bot_id: string; mode: string;
  started_at: number; stopped_at: number | null; stop_reason: string | null;
}
export interface PersistedOrder {
  id: string; bot_id: string; exchange_id: string | null; symbol: string;
  side: string; price: number | null; size: number; status: string;
  filled_size: number; avg_price: number | null; created_at: number; updated_at: number;
}
export interface PersistedPosition {
  id: string; bot_id: string; symbol: string; side: string; size: number;
  avg_entry: number; mark_price: number | null; realized_pnl: number;
  opened_at: number; closed_at: number | null;
}