import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum TimeOffRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  SUBMITTED_TO_HCM = 'SUBMITTED_TO_HCM',
  CONFIRMED = 'CONFIRMED',
  HCM_REJECTED = 'HCM_REJECTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity('time_off_request')
export class TimeOffRequest {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'employee_id', length: 100 })
  employeeId!: string;

  @Column({ name: 'location_id', length: 100 })
  locationId!: string;

  @Column({ name: 'leave_type', length: 50 })
  leaveType!: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

  @Column({
    name: 'days_requested',
    type: 'decimal',
    precision: 10,
    scale: 2,
  })
  daysRequested!: number;

  @Column({
    type: 'varchar',
    length: 30,
    default: TimeOffRequestStatus.PENDING,
  })
  status!: TimeOffRequestStatus;

  @Column({ name: 'rejection_reason', type: 'varchar', nullable: true })
  rejectionReason!: string | null;

  @Column({ name: 'hcm_reference_id', type: 'varchar', length: 200, nullable: true })
  hcmReferenceId!: string | null;

  @Column({ name: 'idempotency_key', length: 200, unique: true })
  idempotencyKey!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
