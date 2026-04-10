import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HcmService } from './hcm.service.js';

@Module({
  imports: [
    HttpModule.register({
      timeout: 5000,
      maxRedirects: 3,
    }),
  ],
  providers: [HcmService],
  exports: [HcmService],
})
export class HcmModule {}
