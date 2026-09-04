import { z } from "zod";

export const OrderSideSchema = z.enum(["BUY", "SELL"]);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const OrderTypeSchema = z.enum(["LIMIT", "MARKET"]);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const CreateOrderInputSchema = z.object({
  marketId: z.string().uuid(),
  outcomeId: z.string().uuid(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  quantity: z.string().regex(/^\d+(\.\d+)?$/, "quantity must be a decimal string"),
  price: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "price must be a decimal string")
    .optional(),
});
export type CreateOrderInput = z.infer<typeof CreateOrderInputSchema>;

export interface MarketSummary {
  id: string;
  slug: string;
  title: string;
  categorySlug: string;
  status: "DRAFT" | "OPEN" | "PAUSED" | "CLOSED" | "RESOLVED";
  closeTime: string | null;
}
