import {
  IsArray,
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsNumber,
  IsDateString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class BatchBalanceItemDto {
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

  @IsNumber()
  @Min(0)
  balance!: number;
}

export class BatchSyncDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchBalanceItemDto)
  balances!: BatchBalanceItemDto[];

  @IsDateString()
  timestamp!: string;
}
