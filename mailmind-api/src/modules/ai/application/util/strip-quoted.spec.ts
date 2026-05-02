import { stripQuotedText } from './strip-quoted';

describe('stripQuotedText', () => {
  it('passes through plain body unchanged', () => {
    const body = 'Selam, yarın 10:00 toplantımız var.\nGörüşürüz.';
    expect(stripQuotedText(body)).toBe(body);
  });

  it('strips Gmail-style "On ... wrote:" reply marker', () => {
    const body = [
      'Tamam, Cuma 14:00 uygun.',
      '',
      'On Mon, May 4, 2026 at 10:30 AM, Ali <ali@x.com> wrote:',
      '> Cuma 14:00 toplantı yapabilir miyiz?',
      '> Ali',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Tamam, Cuma 14:00 uygun.');
  });

  it('strips TR "yazdı:" marker and quoted lines', () => {
    const body = [
      'Anladım, Pazartesi 09:00 buluşalım.',
      '',
      'Ayşe Veli <ayse@firma.com> şunu yazdı:',
      '> Bir toplantı planlayabilir miyiz?',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Anladım, Pazartesi 09:00 buluşalım.');
  });

  it('strips Outlook reply header block', () => {
    const body = [
      'Onayladım, Salı 11:00 olsun.',
      '',
      'From: Mehmet <mehmet@firma.com>',
      'Sent: Monday, May 4, 2026 9:00 AM',
      'To: Me <me@firma.com>',
      'Subject: Re: Toplantı',
      '',
      'Selam, Salı 11:00 müsait misin?',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Onayladım, Salı 11:00 olsun.');
  });

  it('strips Outlook TR "Kimden:" / "Gönderen:" header block', () => {
    const body = [
      'Tamam, Çarşamba uygun.',
      '',
      'Kimden: Ali',
      'Konu: Re: Plan',
      '> Çarşamba müsait misin?',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Tamam, Çarşamba uygun.');
  });

  it('strips "----- Original Message -----" Outlook divider', () => {
    const body = [
      'Onaylıyorum.',
      '',
      '----- Original Message -----',
      'From: Ali',
      'Subject: Toplantı',
      'Cuma 15:00 toplantı?',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Onaylıyorum.');
  });

  it('strips Gmail forward "---------- Forwarded message ----------"', () => {
    const body = [
      'FYI, aşağıdaki mailde yarınki toplantı detayı var.',
      '',
      '---------- Forwarded message ----------',
      'From: Ayşe',
      'Date: Mon, May 4',
      'Subject: Toplantı',
      'Yarın 10:00 toplantı.',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('FYI, aşağıdaki mailde yarınki toplantı detayı var.');
  });

  it('strips standard "-- " signature block', () => {
    const body = [
      'Yarın 14:00 görüşürüz.',
      '',
      '-- ',
      'Ali Veli',
      'Senior Engineer',
      'ali@firma.com',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Yarın 14:00 görüşürüz.');
  });

  it('drops single quoted lines without explicit reply marker', () => {
    const body = [
      'Tamam.',
      '> önceki mesajdan alıntı',
      'Detay sonra.',
    ].join('\n');
    // > satırı drop, kalanlar korunur
    expect(stripQuotedText(body)).toBe('Tamam.\nDetay sonra.');
  });

  it('preserves nested quotes by simply dropping them', () => {
    const body = [
      'Görüşürüz.',
      '',
      '>> derin alıntı',
      '> yüzeysel alıntı',
      '> başka satır',
    ].join('\n');
    expect(stripQuotedText(body)).toBe('Görüşürüz.');
  });

  it('falls back to original body if cleaning would produce near-empty', () => {
    // Tüm body bir reply marker'la başlıyorsa over-strip emniyetine takılır.
    const body = [
      'On Mon, May 4, 2026 at 10:30 AM, Ali <ali@x.com> wrote:',
      '> önemli içerik',
      '> burada',
    ].join('\n');
    expect(stripQuotedText(body)).toBe(body);
  });

  it('returns empty input as-is', () => {
    expect(stripQuotedText('')).toBe('');
  });

  it('handles CRLF line endings', () => {
    const body = 'Onay.\r\n\r\nOn Mon wrote:\r\n> eski';
    expect(stripQuotedText(body)).toBe('Onay.');
  });
});
