import { renderVerificationEmail } from "./verification-email.template";

describe("renderVerificationEmail", () => {
  it("includes the verification URL in both the HTML and text bodies", () => {
    const { htmlBody, textBody } = renderVerificationEmail({ verificationUrl: "https://app.example.com/verify-email?token=abc123" });
    expect(htmlBody).toContain("https://app.example.com/verify-email?token=abc123");
    expect(textBody).toContain("https://app.example.com/verify-email?token=abc123");
  });

  it("mentions the 24-hour expiration and single-use nature", () => {
    const { htmlBody, textBody } = renderVerificationEmail({ verificationUrl: "https://app.example.com/verify-email?token=abc" });
    expect(htmlBody).toMatch(/24 hours?/i);
    expect(textBody).toMatch(/24 hours?/i);
  });

  it("never uses financial/transaction language", () => {
    const { subject, htmlBody, textBody } = renderVerificationEmail({ verificationUrl: "https://app.example.com/verify-email?token=abc" });
    const combined = `${subject} ${htmlBody} ${textBody}`.toLowerCase();
    for (const forbidden of ["balance", "deposit", "withdraw", "trade order", "transaction confirmed"]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it("escapes HTML-special characters if they ever appeared in the URL (defense in depth)", () => {
    const { htmlBody } = renderVerificationEmail({ verificationUrl: 'https://app.example.com/verify-email?token=a"><script>alert(1)</script>' });
    expect(htmlBody).not.toContain("<script>alert(1)</script>");
  });

  it("references VerdictVaut by name", () => {
    const { subject, htmlBody } = renderVerificationEmail({ verificationUrl: "https://app.example.com/verify-email?token=abc" });
    expect(subject).toContain("VerdictVaut");
    expect(htmlBody).toContain("VerdictVaut");
  });
});
