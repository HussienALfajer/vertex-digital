import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

/** Global like config and database: any module that changes data may send a job. */
@Global()
@Module({ providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
