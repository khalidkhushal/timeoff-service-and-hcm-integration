import { Controller, Post, Get, Body, Query } from '@nestjs/common';
import { SyncService } from './sync.service.js';
import { BatchSyncDto } from '../common/dto/batch-sync.dto.js';
import { TriggerSyncDto } from '../common/dto/trigger-sync.dto.js';

@Controller('api/v1/sync')
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('batch')
  async batchSync(@Body() dto: BatchSyncDto) {
    return this.syncService.processBatchSync(dto);
  }

  @Post('trigger')
  async triggerSync(@Body() dto: TriggerSyncDto) {
    return this.syncService.triggerRealtimeSync(dto.employeeId, dto.locationId);
  }

  @Get('logs')
  async getSyncLogs(@Query('limit') limit?: string) {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.syncService.getSyncLogs(parsedLimit);
  }
}
