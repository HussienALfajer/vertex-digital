import { Global, Module } from '@nestjs/common';
import { AltchaController } from './altcha.controller.js';
import { AltchaService } from './altcha.service.js';

/** Global like config and database: the admin sign-in asks for it after repeated failures. */
@Global()
@Module({
  controllers: [AltchaController],
  providers: [AltchaService],
  exports: [AltchaService],
})
export class AltchaModule {}
