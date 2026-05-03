import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.task.findMany({
      where: { userId },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        title: true,
        notes: true,
        dueAt: true,
        status: true,
        priority: true,
        aiAnalysisId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async getOne(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found.');
    if (task.userId !== userId) throw new ForbiddenException();
    return task;
  }

  async create(userId: string, dto: CreateTaskDto) {
    return this.prisma.task.create({
      data: {
        userId,
        title: dto.title,
        notes: dto.notes ?? null,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        priority: dto.priority ?? 'MEDIUM',
      },
    });
  }

  async update(userId: string, taskId: string, dto: UpdateTaskDto) {
    await this.assertOwnership(userId, taskId);

    // rrule: undefined → dokunma; null/boş → temizle; dolu → "RRULE:" prefix'i
    // varsa kırp.
    let rruleUpdate: { rrule: string | null } | object = {};
    if (dto.rrule !== undefined) {
      const trimmed = (dto.rrule ?? '').toString().trim();
      rruleUpdate = { rrule: trimmed.length > 0 ? trimmed.replace(/^RRULE:/i, '') : null };
    }

    return this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.dueAt !== undefined && { dueAt: dto.dueAt ? new Date(dto.dueAt) : null }),
        ...(dto.status !== undefined && { status: dto.status }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...rruleUpdate,
      },
    });
  }

  async remove(userId: string, taskId: string) {
    await this.assertOwnership(userId, taskId);
    await this.prisma.task.delete({ where: { id: taskId } });
    return { deleted: true };
  }

  private async assertOwnership(userId: string, taskId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { userId: true },
    });
    if (!task) throw new NotFoundException('Task not found.');
    if (task.userId !== userId) throw new ForbiddenException();
  }
}
