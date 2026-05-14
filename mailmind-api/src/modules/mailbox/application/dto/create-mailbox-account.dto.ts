import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum MailProviderDto {
  GMAIL = 'GMAIL',
  ICLOUD = 'ICLOUD',
  IMAP = 'IMAP',
}

export class CreateMailboxAccountDto {
  @IsEnum(MailProviderDto)
  provider!: MailProviderDto;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}