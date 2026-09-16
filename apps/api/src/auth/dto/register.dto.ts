import { Transform } from "class-transformer";
import { IsEmail, IsString, MinLength } from "class-validator";

export class RegisterDto {
  // Normalizes BEFORE @IsEmail() validates and before AuthService ever
  // sees it — main.ts's global ValidationPipe runs with transform:
  // true, so this is not optional/best-effort. Without it, "Foo@x.com"
  // and "foo@x.com" register as two distinct accounts (the DB unique
  // constraint is case-sensitive) and, worse, a user who typed their
  // email with different casing at login than at registration (e.g. a
  // mobile keyboard auto-capitalizing the first letter) gets a false
  // "invalid credentials" and is locked out of their own real account.
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(12, { message: "password must be at least 12 characters" })
  password!: string;
}
