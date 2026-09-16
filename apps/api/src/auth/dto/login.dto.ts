import { Transform } from "class-transformer";
import { IsEmail, IsString } from "class-validator";

export class LoginDto {
  // Same normalization as RegisterDto's own — must match exactly, or a
  // user could register with one casing and never be able to log back
  // in with a differently-cased (but semantically identical) email.
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
