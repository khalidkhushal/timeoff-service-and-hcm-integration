import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { RequestService } from './request.service.js';
import { CreateTimeOffRequestDto } from '../common/dto/create-time-off-request.dto.js';
import { RejectRequestDto } from '../common/dto/reject-request.dto.js';
import { TimeOffRequestStatus } from './entities/time-off-request.entity.js';

@Controller('api/v1/time-off-requests')
export class RequestController {
  constructor(private readonly requestService: RequestService) {}

  @Post()
  async create(@Body() dto: CreateTimeOffRequestDto) {
    return this.requestService.create(dto);
  }

  @Get()
  async findAll(
    @Query('employeeId') employeeId?: string,
    @Query('status') status?: TimeOffRequestStatus,
    @Query('locationId') locationId?: string,
  ) {
    return this.requestService.findAll({ employeeId, status, locationId });
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.requestService.findOne(id);
  }

  @Patch(':id/approve')
  async approve(@Param('id', ParseIntPipe) id: number) {
    return this.requestService.approve(id);
  }

  @Patch(':id/reject')
  async reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectRequestDto,
  ) {
    return this.requestService.reject(id, dto.reason);
  }

  @Patch(':id/cancel')
  async cancel(@Param('id', ParseIntPipe) id: number) {
    return this.requestService.cancel(id);
  }
}
