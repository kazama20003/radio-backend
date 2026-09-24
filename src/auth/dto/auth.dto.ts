import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MinLength,
} from 'class-validator';

export class LoginDto {
  /** Correo o código de operador */
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsString()
  @MinLength(6)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

export class ForgotPasswordDto {
  /** Correo o teléfono de la unidad */
  @IsString()
  @IsNotEmpty()
  destination!: string;
}

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  destination!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  destination!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  operatorCode?: string;
}
