import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class RejectRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
