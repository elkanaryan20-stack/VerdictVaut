import { IsString, MinLength } from "class-validator";

export class BroadcastWithdrawalDto {
  @IsString()
  @MinLength(4)
  txHash!: string;
}
