import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { CreateCalendarEventDto } from './dto/create-calendar-event.dto';
import { UpdateCalendarEventDto } from './dto/update-calendar-event.dto';

@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    // CANCELLED takvimde gösterilmez. PROPOSED dahil — frontend renkli
    // ayırt eder; kullanıcı /mail/oneriler'den de yönetebilir.
    return this.prisma.calendarEvent.findMany({
      where: { userId, status: { not: 'CANCELLED' } },
      orderBy: { startAt: 'asc' },
      select: {
        id: true,
        title: true,
        description: true,
        startAt: true,
        endAt: true,
        isAllDay: true,
        location: true,
        attendees: true,
        rrule: true,
        timezone: true,
        status: true,
        aiAnalysisId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async getOne(userId: string, eventId: string) {
    const event = await this.prisma.calendarEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Calendar event not found.');
    if (event.userId !== userId) throw new ForbiddenException();
    return event;
  }

  async create(userId: string, dto: CreateCalendarEventDto) {
    // Manuel kullanıcı oluşturması = zaten onaylı → PENDING.
    // Schema default'u PROPOSED — o AI yolu için. Burada explicit override şart.
    return this.prisma.calendarEvent.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description ?? null,
        startAt: new Date(dto.startAt),
        endAt: dto.endAt ? new Date(dto.endAt) : null,
        location: dto.location ?? null,
        attendees: dto.attendees ? JSON.stringify(dto.attendees) : null,
        status: 'PENDING',
      },
    });
  }

  async update(userId: string, eventId: string, dto: UpdateCalendarEventDto) {
    await this.assertOwnership(userId, eventId);

    // rrule: undefined → dokunma; null/boş → temizle; dolu → "RRULE:" prefix kırp.
    let rruleUpdate: { rrule: string | null } | object = {};
    if (dto.rrule !== undefined) {
      const trimmed = (dto.rrule ?? '').toString().trim();
      rruleUpdate = { rrule: trimmed.length > 0 ? trimmed.replace(/^RRULE:/i, '') : null };
    }

    return this.prisma.calendarEvent.update({
      where: { id: eventId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.startAt !== undefined && { startAt: new Date(dto.startAt) }),
        ...(dto.endAt !== undefined && { endAt: dto.endAt ? new Date(dto.endAt) : null }),
        ...(dto.location !== undefined && { location: dto.location }),
        ...(dto.attendees !== undefined && {
          attendees: dto.attendees && dto.attendees.length > 0 ? JSON.stringify(dto.attendees) : null,
        }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.isAllDay !== undefined && { isAllDay: dto.isAllDay }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        ...rruleUpdate,
      },
    });
  }

  async remove(userId: string, eventId: string) {
    await this.assertOwnership(userId, eventId);
    await this.prisma.calendarEvent.delete({ where: { id: eventId } });
    return { deleted: true };
  }

  private async assertOwnership(userId: string, eventId: string) {
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: { userId: true },
    });
    if (!event) throw new NotFoundException('Calendar event not found.');
    if (event.userId !== userId) throw new ForbiddenException();
  }
}
