import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { SerializableTransactionRunner } from "./serializable-transaction-runner";

@Global()
@Module({
  providers: [PrismaService, SerializableTransactionRunner],
  exports: [PrismaService, SerializableTransactionRunner],
})
export class PrismaModule {}
