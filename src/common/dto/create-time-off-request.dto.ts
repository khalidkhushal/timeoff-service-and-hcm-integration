import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class CreateTimeOffRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  locationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  leaveType!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsNumber()
  @IsPositive()
  daysRequested!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey!: string;
}
