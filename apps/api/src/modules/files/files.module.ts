import { Module } from '@nestjs/common';
import { FileStorage } from './file-storage.js';
import { FilesService } from './files.service.js';

/**
 * Stored files (S03): `stored_files` and the files under `FILES_ROOT`. No routes of its own: the
 * modules that own a file's purpose serve it through `FilesService.serve`.
 */
@Module({
  providers: [FileStorage, FilesService],
  exports: [FilesService],
})
export class FilesModule {}
