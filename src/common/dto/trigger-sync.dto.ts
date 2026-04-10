import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class TriggerSyncDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  employeeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  locationId!: string;
}
