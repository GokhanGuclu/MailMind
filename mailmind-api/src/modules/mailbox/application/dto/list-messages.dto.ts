import { IsOptional, IsString, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

export class ListMessagesDto {
  @IsOptional()
  @IsString()
  folder?: string; // örn: "INBOX", "SENT" — yoksa tüm klasörler

  @IsOptional()
  @IsString()
  cursor?: string; // son sayfanın en eski mesajının id'si (cursor-based pagination)

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc'; // default: en yeni üstte

  /**
   * Serbest metin araması: from / to / subject / snippet alanlarında
   * case-insensitive substring eşleşmesi (Postgres ILIKE).
   */
  @IsOptional()
  @IsString()
  q?: string;
}
