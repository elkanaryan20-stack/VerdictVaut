import { IsString, MinLength } from "class-validator";

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  // Same minimum as RegisterDto — this IS how a user sets a new password,
  // so it must satisfy the same policy new passwords are held to.
  @IsString()
  @MinLength(12, { message: "newPassword must be at least 12 characters" })
  newPassword!: string;
}
