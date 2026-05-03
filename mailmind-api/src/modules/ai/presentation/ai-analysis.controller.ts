import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAccessGuard } from '../../iam/presentation/http/jwt-access.guard';
import { AiAnalysisRepository } from '../infrastructure/persistence/ai-analysis.repository.prisma';
import { EmailAnalyzerService } from '../application/email-analyzer.service';

@UseGuards(JwtAccessGuard)
@Controller('ai/analyses')
export class AiAnalysisController {
  constructor(
    private readonly repo: AiAnalysisRepository,
    private readonly analyzer: EmailAnalyzerService,
  ) {}

  private uid(req: Request): string {
    return (req as any).user?.id;
  }

  /** GET /ai/analyses — kullanıcının tüm analiz kayıtları */
  @Get()
  list(@Req() req: Request) {
    return this.repo.findByUser(this.uid(req));
  }

  /** GET /ai/analyses/:id — analiz detayı (task + event'lerle birlikte) */
  @Get(':id')
  async getOne(@Req() req: Request, @Param('id') id: string) {
    const analysis = await this.repo.findOneByUser(this.uid(req), id);
    if (!analysis) throw new NotFoundException('Analysis not found.');
    return analysis;
  }

  /**
   * POST /ai/analyses/by-message/:messageId/reanalyze
   * Analizi sıfırla; PROPOSED öğeler silinir, onaylanmışlar korunur.
   * Worker yeni PENDING kaydını birkaç saniye içinde alır.
   */
  @Post('by-message/:messageId/reanalyze')
  async reanalyze(@Req() req: Request, @Param('messageId') messageId: string) {
    try {
      return await this.analyzer.reanalyze(this.uid(req), messageId);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Re-analyze failed');
    }
  }

  /**
   * POST /ai/analyses/:id/reanalyze
   * Source mail'in analizini yeniden çalıştır — proposals UI'sından çağrılır.
   */
  @Post(':id/reanalyze')
  async reanalyzeById(@Req() req: Request, @Param('id') id: string) {
    try {
      return await this.analyzer.reanalyzeByAnalysisId(this.uid(req), id);
    } catch (e: any) {
      throw new BadRequestException(e?.message ?? 'Re-analyze failed');
    }
  }
}
