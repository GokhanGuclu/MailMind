import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { JwtAccessGuard } from '../../iam/presentation/http/jwt-access.guard';
import { MailboxMessagesService } from '../application/mailbox-messages.service';
import { MailboxSmtpService } from '../infrastructure/smtp/mailbox-smtp.service';
import { ListMessagesDto } from '../application/dto/list-messages.dto';
import { SendMessageDto } from '../application/dto/send-message.dto';
import { MoveMessageDto } from '../application/dto/move-message.dto';
import { UpdateCategoryDto } from '../application/dto/update-category.dto';

@UseGuards(JwtAccessGuard)
@Controller('mailbox/accounts/:accountId/messages')
export class MailboxMessagesController {
  constructor(
    private readonly messagesSvc: MailboxMessagesService,
    private readonly smtpSvc: MailboxSmtpService,
  ) {}

  private getUserId(req: Request): string {
    const userId = (req as any).user?.id;
    if (!userId) throw new Error('JwtAccessGuard did not attach user id');
    return userId;
  }

  /** GET /mailbox/accounts/:accountId/messages */
  @Get()
  list(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Query() query: ListMessagesDto,
  ) {
    return this.messagesSvc.list(this.getUserId(req), accountId, query);
  }

  /** GET /mailbox/accounts/:accountId/messages/starred */
  @Get('starred')
  listStarred(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Query() query: ListMessagesDto,
  ) {
    return this.messagesSvc.listStarred(this.getUserId(req), accountId, query);
  }

  /** GET /mailbox/accounts/:accountId/messages/unread-count */
  @Get('unread-count')
  unreadCount(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Query('folder') folder?: string,
  ) {
    return this.messagesSvc.unreadCount(this.getUserId(req), accountId, folder);
  }

  /** GET /mailbox/accounts/:accountId/messages/:id */
  @Get(':id')
  getOne(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    return this.messagesSvc.getOne(this.getUserId(req), accountId, id);
  }

  /**
   * GET /mailbox/accounts/:accountId/messages/:id/thread
   * Bu mesajın bağlı olduğu konuşmadaki tüm mesajları döner (özet alanlar).
   */
  @Get(':id/thread')
  getThread(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    return this.messagesSvc.getThread(this.getUserId(req), accountId, id);
  }

  /** PATCH /mailbox/accounts/:accountId/messages/:id/star */
  @Patch(':id/star')
  toggleStar(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    return this.messagesSvc.toggleStar(this.getUserId(req), accountId, id);
  }

  /** PATCH /mailbox/accounts/:accountId/messages/:id/read */
  @Patch(':id/read')
  markAsRead(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    return this.messagesSvc.markAsRead(this.getUserId(req), accountId, id);
  }

  /** PATCH /mailbox/accounts/:accountId/messages/:id/unread */
  @Patch(':id/unread')
  markAsUnread(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    return this.messagesSvc.markAsUnread(this.getUserId(req), accountId, id);
  }

  /**
   * DELETE /mailbox/accounts/:accountId/messages/:id
   * Kalıcı silme — sadece TRASH klasöründeki mesajlar için geçerli (service
   * tarafında zorlanır). IMAP'ten ve DB'den silinir.
   */
  @Delete(':id')
  @HttpCode(204)
  async hardDelete(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    await this.messagesSvc.hardDelete(this.getUserId(req), accountId, id);
  }

  /** PATCH /mailbox/accounts/:accountId/messages/:id/move */
  @Patch(':id/move')
  move(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body() dto: MoveMessageDto,
  ) {
    return this.messagesSvc.moveToFolder(this.getUserId(req), accountId, id, dto.folder);
  }

  /** PATCH /mailbox/accounts/:accountId/messages/:id/category */
  @Patch(':id/category')
  updateCategory(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.messagesSvc.updateCategory(this.getUserId(req), accountId, id, dto.category);
  }

  /** POST /mailbox/accounts/:accountId/messages/:id/summarize */
  @Post(':id/summarize')
  summarize(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') id: string,
  ) {
    return this.messagesSvc.summarize(this.getUserId(req), accountId, id);
  }

  /** POST /mailbox/accounts/:accountId/messages/send */
  @Post('send')
  send(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.smtpSvc.send(this.getUserId(req), accountId, dto);
  }

  /**
   * GET /mailbox/accounts/:accountId/messages/:id/attachments/:attId
   * Binary stream — Content-Disposition attachment header'ı ile.
   * `attId` MailboxAttachment.id; tek mailin tek ekini döner.
   */
  @Get(':id/attachments/:attId')
  async downloadAttachment(
    @Req() req: Request,
    @Param('accountId') accountId: string,
    @Param('id') messageId: string,
    @Param('attId') attId: string,
    @Res() res: Response,
  ) {
    const att = await this.messagesSvc.getAttachment(
      this.getUserId(req),
      messageId,
      attId,
      accountId,
    );
    if (!att) throw new NotFoundException('Attachment not found.');

    // RFC 5987 ile UTF-8 dosya adı (Türkçe karakter / boşluk için).
    const encoded = encodeURIComponent(att.filename);
    res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${att.filename.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Content-Length', String(att.content.length));
    res.end(att.content);
  }
}
