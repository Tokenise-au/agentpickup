/** How the order was paid: card checkout, x402, MPP, or through an agent checkout protocol (UCP, ACP). */
export type PaymentRail = "card" | "x402" | "mpp" | "ucp" | "acp" | "test";

/**
 * awaiting_payment → paid → (ready) → collected
 *                         ↘ expired (hold released, or refund owed)
 * awaiting_payment → cancelled
 */
export type OrderStatus = "awaiting_payment" | "paid" | "ready" | "collected" | "expired" | "cancelled";

/** "hold" takes the money at handover (card holds); "charge" takes it at order time. */
export type CaptureMode = "hold" | "charge";

export interface OrderItem {
  id: string;
  name: string;
  qty: number;
  unitCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  rail: PaymentRail;
  captureMode: CaptureMode;
  items: OrderItem[];
  totalCents: number;
  currency: string;
  customerEmail: string | null;
  customerName: string | null;
  /** Stripe PaymentIntent id, or the settlement transaction hash for x402. */
  paymentRef: string | null;
  /** Wallet address for x402 payers. */
  payer: string | null;
  passId: string | null;
  pickupCode: string | null;
  /** Unix ms. After this the order expires and the hold is released. */
  collectBy: number;
  createdAt: number;
  paidAt: number | null;
  readyAt: number | null;
  collectedAt: number | null;
  /** True when money was taken but the order was never collected. */
  refundDue: boolean;
  /**
   * What an x402 payer pays, in US cents, fixed when the order was created. Set only when the shop prices
   * in another currency; otherwise x402 pays totalCents.
   */
  usdCents?: number | null;
}

export type CollectEventType =
  | "order.created"
  | "order.paid"
  | "order.ready"
  | "order.collected"
  | "order.expired"
  | "order.cancelled"
  | "order.refunded"
  | "pass.emailed";

export interface CollectEvent {
  id: string;
  type: CollectEventType;
  orderId: string;
  at: number;
  data?: Record<string, unknown>;
}
