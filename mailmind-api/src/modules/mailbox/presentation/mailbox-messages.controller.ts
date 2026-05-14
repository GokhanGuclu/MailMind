import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

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
}
