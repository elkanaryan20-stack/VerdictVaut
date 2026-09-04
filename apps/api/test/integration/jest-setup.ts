import { prisma } from "./helpers";

// Jest resets the module registry between test FILES even under
// --runInBand, but that does not close the underlying Postgres
// connections a fresh PrismaService instance opens — without this, each
// file's connections leak and the pool is exhausted a few files in
// (every "stuck" query is actually queued forever waiting for a
// connection Postgres already finished with but was never released).
afterAll(async () => {
  await prisma.$disconnect();
});
