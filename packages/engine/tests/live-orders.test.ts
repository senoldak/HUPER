import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveExchange } from "../src/exchange/live.js";
import { Side, OrderType, OrderStatus } from "@huper/core";

const orderMock = vi.hoisted(() => ({ order: vi.fn() }));
const clearinghouseMock = vi.hoisted(() => ({ clearinghouseState: vi.fn() }));
const midListener = vi.hoisted(() => ({ current: undefined as ((d: { mids: Record<string, string> }) => void) | undefined }));
const fillListener = vi.hoisted(() => ({ current: undefined as ((e: { fills: unknown[] }) => void) | undefined }));

vi.mock("@nktkas/hyperliquid", () => {
  class FakeSubscription {
    unsubscribe = vi.fn(async () => {});
  }
  class FakeTransport {}
  class FakeExchangeClient {
    order = orderMock.order;
  }
  class FakeInfoClient {
    clearinghouseState = clearinghouseMock.clearinghouseState;
  }
  class FakeSubscriptionClient {
    async allMids(listener: (d: { mids: Record<string, string> }) => void) {
      midListener.current = listener;
      return new FakeSubscription();
    }
    async userFills(_params: unknown, listener: (e: { fills: unknown[] }) => void) {
      fillListener.current = listener;
      return new FakeSubscription();
    }
    async l2Book() {
      return new FakeSubscription();
    }
  }
  return {
    HttpTransport: FakeTransport,
    WebSocketTransport: FakeTransport,
    ExchangeClient: FakeExchangeClient,
    InfoClient: FakeInfoClient,
    SubscriptionClient: FakeSubscriptionClient,
  };
});

const KEY = "0x" + "11".repeat(32);
const OPTS = { privateKey: KEY, rpcUrl: "http://rpc.test", wsUrl: "ws://ws.test" };
const STATE = { marginSummary: { accountValue: "10000" }, assetPositions: [] };

const pushMid = (coin: string, mid: string) => midListener.current?.({ mids: { [coin]: mid } });
const emitFill = (oid: number, px: string, sz: string) =>
  fillListener.current?.({ fills: [{ oid, coin: "BTC", px, sz, side: "B", time: Date.now(), dir: "Buy", closedPnl: "0", hash: "0xabc", crossed: false, fee: "0", tid: 1, feeToken: "USDC", twapId: null }] });

describe("LiveExchange userFills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearinghouseMock.clearinghouseState.mockResolvedValue(STATE);
  });

  it("returns a filled market Ioc order immediately", async () => {
    orderMock.order.mockResolvedValueOnce({ response: { data: { statuses: [{ filled: { oid: 1, totalSz: "0.1", avgPx: "100" } }] } } });
    const ex = new LiveExchange(OPTS);
    const onFill = vi.fn();
    ex.onFill(onFill);
    await ex.connect();
    pushMid("BTC", "100");

    const placed = await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: null, size: 0.1, type: OrderType.Market });

    expect(placed.status).toBe(OrderStatus.Filled);
    expect(placed.filledSize).toBe(0.1);
    expect(placed.avgFillPrice).toBe(100);
    expect(onFill).toHaveBeenCalledTimes(0);
    await ex.disconnect();
  });

  it("emits onFill when userFills reports a pending resting order filled", async () => {
    orderMock.order.mockResolvedValueOnce({ response: { data: { statuses: [{ resting: { oid: 2 } }] } } });
    const ex = new LiveExchange(OPTS);
    const fills: unknown[] = [];
    ex.onFill((o) => fills.push(o));
    await ex.connect();

    const placed = await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: 99, size: 0.1, type: OrderType.Limit });
    expect(placed.status).toBe(OrderStatus.Open);

    emitFill(2, "99", "0.1");

    expect(fills).toHaveLength(1);
    const filled = fills[0] as { status: string; filledSize: number; id: string };
    expect(filled.status).toBe(OrderStatus.Filled);
    expect(filled.filledSize).toBe(0.1);
    expect(filled.id).toBe("2");
    await ex.disconnect();
  });

  it("removes a filled order from ordersPending (no stale re-emit)", async () => {
    const ex = new LiveExchange(OPTS);
    const onFill = vi.fn();
    ex.onFill(onFill);
    await ex.connect();
    orderMock.order.mockResolvedValueOnce({ response: { data: { statuses: [{ resting: { oid: 3 } }] } } });
    await ex.placeOrder({ symbol: "BTC", side: Side.Buy, price: 99, size: 0.1, type: OrderType.Limit });

    emitFill(3, "99", "0.1");
    expect(onFill).toHaveBeenCalledTimes(1);
    // A duplicate fill for the same oid must not fire again (order was deleted from the pending map).
    emitFill(3, "99", "0.1");
    expect(onFill).toHaveBeenCalledTimes(1);
    await ex.disconnect();
  });
});