import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { DeferredComplianceGate } from "./withdrawals/compliance/deferred-compliance-gate";
import { WITHDRAWAL_COMPLIANCE_GATE, WithdrawalComplianceGate } from "./withdrawals/compliance/withdrawal-compliance-gate.interface";

/**
 * Belt-and-suspenders alongside env.validation.ts's boot-time refusal
 * of APP_ENVIRONMENT=production (currently absolute, blocking 100% of
 * production boots for the custody reason alone) — the same reasoning
 * WithdrawalExecutorFactory already applies to custody. This checks
 * the ACTUAL bound compliance gate implementation at real application
 * bootstrap (after Nest's DI container has resolved it), not just
 * source text, so it keeps telling the truth even if custody's own
 * gate is ever relaxed independently and this is the only thing left
 * standing between production and an unscreened withdrawal path.
 *
 * Deliberately narrow: this checks WHICH CLASS is bound, not whether
 * that class "looks right" — a real compliance provider replacing
 * DeferredComplianceGate is exactly what turns this check off.
 */
@Injectable()
export class ProductionSafetyGate implements OnApplicationBootstrap {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(WITHDRAWAL_COMPLIANCE_GATE) private readonly complianceGate: WithdrawalComplianceGate,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get("appEnvironment", { infer: true }) !== "production") return;

    if (this.complianceGate instanceof DeferredComplianceGate) {
      throw new Error(
        "APP_ENVIRONMENT=production refuses to finish starting: WITHDRAWAL_COMPLIANCE_GATE is still bound to " +
          "DeferredComplianceGate, a placeholder that defers every KYC/AML/sanctions decision to a human with no " +
          "automated screening. Bind a real WithdrawalComplianceGate implementation before running in production.",
      );
    }
  }
}
