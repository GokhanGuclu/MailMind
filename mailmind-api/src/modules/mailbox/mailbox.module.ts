import { Module } from '@nestjs/common';
import { MailboxController } from './presentation/mailbox.controller';
import { MailboxAccountsController } from './presentation/mailbox-accounts.controller';
import { MailboxMessagesController } from './presentation/mailbox-messages.controller';
import { MailboxUnifiedMessagesController } from './presentation/mailbox-unified-messages.controller';
import { MailboxAccountsService } from './application/mailbox-accounts.service';
import { MailboxMessagesService } from './application/mailbox-messages.service';
import { OutboxWorkerService } from './infrastructure/outbox/outbox-worker.service';
import { MailboxSyncWorkerService } from './infrastructure/providers/sync/mailbox-sync-worker.service';
import { ImapProvider } from './infrastructure/providers/imap/imap.provider';
import { GoogleTokenService } from './infrastructure/providers/oauth/google-token.service';
import { MailboxSmtpService } from './infrastructure/smtp/mailbox-smtp.service';
import { CredentialCipher } from '../../shared/infrastructure/security/credential-cipher';
import { AiModule } from '../ai/ai.module';
import { MailClassifierModule } from '../mail-classifier/mail-classifier.module';

@Module({
  imports: [AiModule, MailClassifierModule],
  controllers: [
    MailboxController,
    MailboxAccountsController,
    MailboxMessagesController,
    MailboxUnifiedMessagesController,
  ],
  providers: [
    CredentialCipher,
    MailboxAccountsService,
    MailboxMessagesService,
    MailboxSmtpService,
    OutboxWorkerService,
    MailboxSyncWorkerService,
    ImapProvider,
    GoogleTokenService,
  ],
  exports: [MailboxAccountsService],
})
export class MailboxModule {}