export const Side = { Buy: "buy", Sell: "sell" } as const;
export type Side = (typeof Side)[keyof typeof Side];

export const OrderType = { Limit: "limit", Market: "market" } as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const OrderStatus = {
  New: "new",
  Open: "open",
  Filled: "filled",
  PartiallyFilled: "partially_filled",
  Cancelled: "cancelled",
  Rejected: "rejected",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export interface NewOrder {
  symbol: string;
  side: Side;
  type?: OrderType;
  price: number | null;
  size: number;
  reduceOnly?: boolean;
  cloid?: string;
}

export interface Order extends NewOrder {
  id: string;
  status: OrderStatus;
  filledSize: number;
  avgFillPrice: number | null;
  createdAt: number;
  filledAt?: number;
  error?: string;
}

export interface Position {
  symbol: string;
  side: Side;
  size: number;
  avgEntry: number;
  markPrice?: number;
}

export interface PriceTick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}

export type PriceLevel = [price: number, size: number];

export interface OrderBook {
  symbol: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number;
}

export interface Wallet {
  asset: string;
  available: number;
  total: number;
}

export interface ExchangeAdapter {
  readonly mode: "paper" | "live";
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  tick(symbol: string): Promise<PriceTick | undefined>;
  orderbook(symbol: string): Promise<OrderBook | undefined>;
  balances(): Promise<Wallet[]>;
  openPositions(): Promise<Position[]>;
  placeOrder(order: NewOrder): Promise<Order>;
  cancelOrder(orderId: string): Promise<boolean>;
  onTick(cb: (tick: PriceTick) => void): () => void;
  onFill(cb: (order: Order) => void): () => void;
}