import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { validateEnv } from "./config/env.validation";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { UsersModule } from "./users/users.module";
import { MarketsModule } from "./markets/markets.module";
import { TradingModule } from "./trading/trading.module";
import { LedgerModule } from "./ledger/ledger.module";
import { WalletModule } from "./wallet/wallet.module";
import { AdminModule } from "./admin/admin.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    MarketsModule,
    TradingModule,
    LedgerModule,
    WalletModule,
    AdminModule,
  ],
})
export class AppModule {}
