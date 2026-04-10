import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  VersionColumn,
} from 'typeorm';

@Entity('time_off_balance')
@Unique(['employeeId', 'locationId', 'leaveType'])
export class TimeOffBalance {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'employee_id', length: 100 })
  employeeId!: string;

  @Column({ name: 'location_id', length: 100 })
  locationId!: string;

  @Column({ name: 'leave_type', length: 50 })
  leaveType!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  balance!: number;

  @Column({
    name: 'pending_deductions',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
  })
  pendingDeductions!: number;

  @Column({ name: 'last_synced_at', type: 'datetime', nullable: true })
  lastSyncedAt!: Date | null;

  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  get availableBalance(): number {
    return Number(this.balance) - Number(this.pendingDeductions);
  }
}
