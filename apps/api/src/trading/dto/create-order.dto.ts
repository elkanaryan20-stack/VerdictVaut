import { IsEnum, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";
import { OrderSide, OrderType } from "@prisma/client";

const DECIMAL_STRING = /^\d+(\.\d+)?$/;

export class CreateOrderDto {
  @IsUUID()
  marketId!: string;

  @IsUUID()
  outcomeId!: string;

  @IsEnum(OrderSide)
  side!: OrderSide;

  @IsEnum(OrderType)
  type!: OrderType;

  // MaxLength bounds the string BEFORE it ever reaches new Prisma.Decimal(...)
  // — no real price/quantity needs anywhere near 40 digits, and without a
  // bound an attacker-supplied digit string of unbounded length costs CPU
  // to validate/parse on every submission to an authenticated endpoint
  // (Phase 11 finding; TRADING_THROTTLE already rate-limits this route).
  @IsString()
  @MaxLength(40)
  @Matches(DECIMAL_STRING, { message: "quantity must be a positive decimal string" })
  quantity!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(DECIMAL_STRING, { message: "price must be a positive decimal string" })
  price?: string;

  /**
   * Idempotency key. Optional — if omitted, the server generates one,
   * meaning that specific call gets no retry-safety, but the column is
   * never null (see Order.clientOrderId). Supply your own to make retries
   * of this exact submission safe.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientOrderId?: string;
}
