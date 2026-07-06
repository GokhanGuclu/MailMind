import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { JwtAccessGuard } from '../../iam/presentation/http/jwt-access.guard';
import { MailboxAccountsService } from '../application/mailbox-accounts.service';
import { CreateMailboxAccountDto } from '../application/dto/create-mailbox-account.dto';
import { ActivateMailboxAccountDto } from '../application/dto/activate-mailbox-account.dto';
import { MailboxSyncWorkerService } from '../infrastructure/providers/sync/mailbox-sync-worker.service';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

@UseGuards(JwtAccessGuard)
@Controller('mailbox/accounts')
export class MailboxAccountsController {
  constructor(
    private readonly svc: MailboxAccountsService,
    private readonly syncWorker: MailboxSyncWorkerService,
    private readonly prisma: PrismaService,
  ) {}

  private getUserId(req: Request): string {
    const userId = (req as any).user?.id;
    if (!userId) throw new Error('JwtAccessGuard did not attach user id on req.user');
    return userId;
  }

  @Post()
  create(@Req() req: Request, @Body() dto: CreateMailboxAccountDto) {
    return this.svc.create(this.getUserId(req), dto);
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.getUserId(req));
  }

  @Post(':id/activate')
  activate(@Req() req: Request, @Param('id') id: string, @Body() dto: ActivateMailboxAccountDto) {
    return this.svc.activate(this.getUserId(req), id, dto);
  }

  @Post(':id/revoke')
  revoke(@Req() req: Request, @Param('id') id: string) {
    return this.svc.revoke(this.getUserId(req), id);
  }

  @Post(':id/pause')
  pause(@Req() req: Request, @Param('id') id: string) {
    return this.svc.pause(this.getUserId(req), id);
  }

  @Post(':id/resume')
  resume(@Req() req: Request, @Param('id') id: string) {
    return this.svc.resume(this.getUserId(req), id);
  }

  /**
   * POST /mailbox/accounts/:id/sync
   * Cooldown'ı bypass eder; hemen yeni INCREMENTAL sync job'u açar.
   * UI "Şimdi senkronize et" butonu için. Idempotent — zaten PENDING/RUNNING
   * varsa yeni job açmaz.
   */
  @Post(':id/sync')
  async sync(@Req() req: Request, @Param('id') id: string) {
    const userId = this.getUserId(req);
    const acc = await this.prisma.mailboxAccount.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true },
    });
    if (!acc) throw new NotFoundException('Mailbox account not found.');
    if (acc.userId !== userId) throw new ForbiddenException();
    await this.syncWorker.enqueueIncrementalForMailbox(id);
    return { enqueued: true };
  }

  /**
   * POST /mailbox/accounts/sync-all
   * Kullanıcının TÜM ACTIVE hesapları için force sync. Demo'da tek tuş için.
   */
  @Post('sync-all')
  async syncAll(@Req() req: Request) {
    const userId = this.getUserId(req);
    const accounts = await this.prisma.mailboxAccount.findMany({
      where: { userId, status: 'ACTIVE' },
      select: { id: true },
    });
    await Promise.all(accounts.map((a) => this.syncWorker.enqueueIncrementalForMailbox(a.id)));
    return { enqueued: accounts.length };
  }
}