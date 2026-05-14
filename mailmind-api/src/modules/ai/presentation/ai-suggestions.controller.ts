import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAccessGuard } from '../../iam/presentation/http/jwt-access.guard';
import { AiSuggestionsService } from '../application/ai-suggestions.service';

@UseGuards(JwtAccessGuard)
@Controller('ai/suggestions')
export class AiSuggestionsController {
  constructor(private readonly svc: AiSuggestionsService) {}

  private uid(req: Request): string {
    return (req as any).user?.id;
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.uid(req));
  }

  @Get('count')
  count(@Req() req: Request) {
    return this.svc.count(this.uid(req));
  }

  @Post(':id/approve')
  approve(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { eventId?: string } = {},
  ) {
    return this.svc.approve(this.uid(req), id, { eventId: body.eventId });
  }

  @Post(':id/reject')
  reject(@Req() req: Request, @Param('id') id: string) {
    return this.svc.reject(this.uid(req), id);
  }
}
