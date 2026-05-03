import { Module } from '@nestjs/common';
import { AiAnalysisController } from './presentation/ai-analysis.controller';
import { AiComposeController } from './presentation/ai-compose.controller';
import { AiProposalsController } from './presentation/ai-proposals.controller';
import { AiProposalsService } from './application/ai-proposals.service';
import { AiStatsController } from './presentation/ai-stats.controller';
import { AiStatsService } from './application/ai-stats.service';
import { EmailAnalyzerService } from './application/email-analyzer.service';
import { AiWorkerService } from './application/ai-worker.service';
import { AiComposeService } from './application/ai-compose.service';
import { RecurrenceDetectorService } from './application/recurrence-detector.service';
import { EventMatcherService } from './application/event-matcher.service';
import { ReminderSchedulerService } from './application/reminder-scheduler.service';
import { OllamaProvider } from './infrastructure/ollama/ollama.provider';
import { AiAnalysisRepository } from './infrastructure/persistence/ai-analysis.repository.prisma';
import { AI_PROVIDER_TOKEN } from './application/ports/ai-provider.port';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [
    AiAnalysisController,
    AiComposeController,
    AiProposalsController,
    AiStatsController,
  ],
  providers: [
    // Port → Implementation bağlantısı
    { provide: AI_PROVIDER_TOKEN, useClass: OllamaProvider },
    EmailAnalyzerService,
    AiWorkerService,
    AiComposeService,
    AiAnalysisRepository,
    RecurrenceDetectorService,
    EventMatcherService,
    ReminderSchedulerService,
    AiProposalsService,
    AiStatsService,
  ],
  exports: [EmailAnalyzerService, RecurrenceDetectorService],
})
export class AiModule {}
