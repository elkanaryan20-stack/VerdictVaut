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

  @IsString()
  @Matches(DECIMAL_STRING, { message: "quantity must be a positive decimal string" })
  quantity!: string;

  @IsOptional()
  @IsString()
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
