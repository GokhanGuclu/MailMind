import { Module } from '@nestjs/common';
import { MailClassifierService } from './mail-classifier.service';

@Module({
  providers: [MailClassifierService],
  exports: [MailClassifierService],
})
export class MailClassifierModule {}
