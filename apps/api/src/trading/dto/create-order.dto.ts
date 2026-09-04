import { IsEnum, IsOptional, IsString, IsUUID, Matches } from "class-validator";
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
}
