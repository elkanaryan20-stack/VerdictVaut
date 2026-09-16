import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { LoginDto } from "./login.dto";
import { RegisterDto } from "./register.dto";

/**
 * Phase 30 — exercises the real class-transformer/class-validator
 * pipeline main.ts's global `ValidationPipe({ transform: true })`
 * actually runs on every request, not just the DTO class definition in
 * isolation. This is what proves the @Transform decorator genuinely
 * fires BEFORE @IsEmail() validates (order matters — see each DTO's
 * own comment for why a differently-cased login must resolve to the
 * same account a user registered with).
 */
describe("RegisterDto/LoginDto email normalization", () => {
  it("RegisterDto lowercases and trims a mixed-case email before validation", async () => {
    const dto = plainToInstance(RegisterDto, { email: "  Foo@Example.COM  ", password: "a-real-password-123" });
    expect(dto.email).toBe("foo@example.com");

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("LoginDto lowercases and trims a mixed-case email before validation", async () => {
    const dto = plainToInstance(LoginDto, { email: " Foo@Example.COM ", password: "whatever" });
    expect(dto.email).toBe("foo@example.com");

    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("registering as 'Foo@Example.com' and logging in as 'foo@example.com' normalize to the identical string", async () => {
    const registered = plainToInstance(RegisterDto, { email: "Foo@Example.com", password: "a-real-password-123" });
    const loggedIn = plainToInstance(LoginDto, { email: "foo@example.com", password: "whatever" });
    expect(registered.email).toBe(loggedIn.email);
  });

  it("still rejects a genuinely invalid email after normalization", async () => {
    const dto = plainToInstance(RegisterDto, { email: "NOT-AN-EMAIL", password: "a-real-password-123" });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === "email")).toBe(true);
  });
});
