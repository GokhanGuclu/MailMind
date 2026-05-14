import { IsIn, IsString } from 'class-validator';

/**
 * Sınıflandırıcı modelinin ürettiği etiketler. Kullanıcı manuel olarak da
 * bu setten bir değer seçebilir; başka bir string kabul etmiyoruz ki
 * "kategori" alanı serbest metin çöpüne dönüşmesin.
 */
export const MESSAGE_CATEGORIES = [
  'İş/Acil',
  'Kişisel',
  'Bildirim',
  'Güvenlik',
  'Spam',
  'Diğer',
] as const;

export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];

export class UpdateCategoryDto {
  @IsString()
  @IsIn(MESSAGE_CATEGORIES as unknown as string[])
  category: MessageCategory;
}
