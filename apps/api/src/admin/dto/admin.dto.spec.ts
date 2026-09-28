import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import * as fs from "fs";
import * as path from "path";
import { CreateAssetNetworkDto } from "./admin.dto";

/** Same options as main.ts's global ValidationPipe. */
function errorsFor(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateAssetNetworkDto, payload, { enableImplicitConversion: false });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("CreateAssetNetworkDto (Phase 40)", () => {
  const valid = { assetSymbol: "BTC", networkCode: "bitcoin-mainnet", isNative: true, minConfirmations: 3 };

  it("accepts a well-formed request — previously EVERY request was rejected ('minConfirmations should not exist')", () => {
    expect(errorsFor(valid)).toEqual([]);
    expect(errorsFor({ ...valid, depositMinAmount: "0.0001", withdrawalMinAmount: "0.001" })).toEqual([]);
  });

  it("validates minConfirmations and the minimum-amount fields", () => {
    expect(errorsFor({ ...valid, minConfirmations: 0 }).length).toBeGreaterThan(0);
    expect(errorsFor({ ...valid, minConfirmations: 1.5 }).length).toBeGreaterThan(0);
    expect(errorsFor({ ...valid, depositMinAmount: "-1" }).length).toBeGreaterThan(0);
    expect(errorsFor({ ...valid, withdrawalMinAmount: "1e3" }).length).toBeGreaterThan(0);
  });
});

/**
 * Regression guard for the whole codebase: with forbidNonWhitelisted, a DTO
 * property carrying no class-validator decorator is rejected on every
 * request — silently making its endpoint unusable. Every DTO property must
 * be immediately preceded by a decorator line.
 */
describe("every DTO property is decorated (Phase 40)", () => {
  const srcRoot = path.join(__dirname, "..", "..");
  const dtoFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts") && /class \w+Dto\b/.test(fs.readFileSync(full, "utf8"))) dtoFiles.push(full);
    }
  };
  walk(srcRoot);

  it("found DTO files to check", () => {
    expect(dtoFiles.length).toBeGreaterThan(5);
  });

  it("has no undecorated DTO property", () => {
    const offenders: string[] = [];
    for (const file of dtoFiles) {
      let inDtoClass = false;
      let previous = "";
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        if (/^export class \w+Dto\b/.test(line)) {
          inDtoClass = true;
          previous = "";
          continue;
        }
        if (inDtoClass && /^}/.test(line)) inDtoClass = false;
        if (inDtoClass && /^ {2}\w+[!?]?:/.test(line) && !/^\s*@/.test(previous)) offenders.push(`${path.relative(srcRoot, file)}: ${line.trim()}`);
        if (inDtoClass && line.trim() && !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")) previous = line;
      }
    }
    expect(offenders).toEqual([]);
  });
});
