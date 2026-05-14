import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Compose'da maile eklenen attachment'lar base64 olarak JSON gövdesinde
  // taşınıyor; UI tarafında toplam 20 MB sınırı var (MAX_ATTACHMENT_BYTES).
  // Express default JSON limiti 100 KB → base64 şişmesiyle 25-30 MB'lık
  // payload'lar gelebilir, bu yüzden sınırı 30 MB'a çıkarıyoruz.
  app.use(json({ limit: '30mb' }));
  app.use(urlencoded({ limit: '30mb', extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,            // @Type decorators work (string → number etc.)
      whitelist: true,             // strip unknown properties
      forbidNonWhitelisted: false, // don't throw on extra props
    }),
  );

  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://localhost:8081')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.enableShutdownHooks();

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
}
bootstrap();