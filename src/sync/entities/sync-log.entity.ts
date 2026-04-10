import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum SyncType {
  REALTIME = 'REALTIME',
  BATCH = 'BATCH',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

@Entity('sync_log')
export class SyncLog {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'sync_type', type: 'varchar', length: 20 })
  syncType!: SyncType;

  @Column({ type: 'varchar', length: 20 })
  status!: SyncStatus;

  @Column({ name: 'records_processed', type: 'integer', default: 0 })
  recordsProcessed!: number;

  @Column({ name: 'records_failed', type: 'integer', default: 0 })
  recordsFailed!: number;

  @Column({ name: 'error_details', type: 'varchar', nullable: true })
  errorDetails!: string | null;

  @CreateDateColumn({ name: 'started_at' })
  startedAt!: Date;

  @Column({ name: 'completed_at', type: 'datetime', nullable: true })
  completedAt!: Date | null;
}
