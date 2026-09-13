import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { emailProviderFactory } from "./email-provider.factory";
import { NoopEmailProvider } from "./noop-email.provider";
import { PostmarkEmailProvider } from "./postmark-email.provider";

function fakeConfig(email: AppConfig["email"]): ConfigService<AppConfig, true> {
  return { get: () => email } as unknown as ConfigService<AppConfig, true>;
}

const fakeMetrics = { increment: jest.fn(), gauge: jest.fn(), timing: jest.fn() } as never;

describe("emailProviderFactory", () => {
  it("selects NoopEmailProvider when EMAIL_PROVIDER is 'none' (the default)", () => {
    const provider = emailProviderFactory(fakeConfig({ provider: "none", postmarkServerToken: "", fromAddress: "", baseUrl: "" }), fakeMetrics);
    expect(provider).toBeInstanceOf(NoopEmailProvider);
  });

  it("selects PostmarkEmailProvider when EMAIL_PROVIDER is 'postmark'", () => {
    const provider = emailProviderFactory(
      fakeConfig({ provider: "postmark", postmarkServerToken: "real-token", fromAddress: "noreply@verdictvaut.test", baseUrl: "https://app.example.com" }),
      fakeMetrics,
    );
    expect(provider).toBeInstanceOf(PostmarkEmailProvider);
  });
});
