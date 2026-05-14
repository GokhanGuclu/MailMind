import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { JwtAccessGuard } from '../../iam/presentation/http/jwt-access.guard';
import { MailboxMessagesService } from '../application/mailbox-messages.service';
import { ListMessagesDto } from '../application/dto/list-messages.dto';

/**
 * "Tüm Gelen Kutusu" — kullanıcının tüm hesaplarındaki mesajları account-agnostic
 * birleşik tek listede döner. Çoklu hesap UI'ında ana akış bu endpoint üstünden
 * gider; per-account görünüm için MailboxMessagesController kullanılmaya devam.
 */
@UseGuards(JwtAccessGuard)
@Controller('mailbox/messages')
export class MailboxUnifiedMessagesController {
  constructor(private readonly messagesSvc: MailboxMessagesService) {}

  private getUserId(req: Request): string {
    const userId = (req as any).user?.id;
    if (!userId) throw new Error('JwtAccessGuard did not attach user id');
    return userId;
  }

  /** GET /mailbox/messages */
  @Get()
  list(@Req() req: Request, @Query() query: ListMessagesDto) {
    return this.messagesSvc.listAll(this.getUserId(req), query);
  }

  /** GET /mailbox/messages/starred */
  @Get('starred')
  listStarred(@Req() req: Request, @Query() query: ListMessagesDto) {
    return this.messagesSvc.listAllStarred(this.getUserId(req), query);
  }

  /**
   * GET /mailbox/messages/:id — account-agnostic tek mesaj getirme.
   * Compose'da Yanıtla/Yönlendir akışı orijinal maili yükleyebilsin diye var;
   * kullanıcının sahibi olmadığı message için 404, başkasınınki için 403 döner.
   */
  @Get(':id')
  async getOne(@Req() req: Request, @Param('id') id: string) {
    const userId = this.getUserId(req);
    const msg = await this.messagesSvc.getOneByIdForUser(userId, id);
    if (!msg) throw new NotFoundException('Message not found.');
    return msg;
  }
}
