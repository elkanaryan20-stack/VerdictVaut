import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";
import { ReservationService } from "./reservation.service";

@Module({
  providers: [LedgerService, ReservationService],
  exports: [LedgerService, ReservationService],
})
export class LedgerModule {}
