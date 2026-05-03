import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

enum CalendarEventStatusDto {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
}

export class UpdateCalendarEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString({ each: true })
  attendees?: string[];

  @IsOptional()
  @IsEnum(CalendarEventStatusDto)
  status?: CalendarEventStatusDto;

  /** Tüm gün etkinliği (saat bilinmiyor): startAt o günün 00:00'ı olur. */
  @IsOptional()
  @IsBoolean()
  isAllDay?: boolean;

  /** RFC 5545 RRULE — boş string veya null → tekrar temizlenir. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  rrule?: string | null;

  /** IANA tz; user'ın saat dilimi default. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
