# TASKS — Off-server backups (Q1, launch checklist; branch `feat/offsite-backups`)

The owner chose Backblaze B2 on 2026-10-28 and created the bucket (Object Lock 30 days, lifecycle 31 + 1 days) and a key limited to it, in `/etc/vertexdigital/backup.env` on the server.

- [x] Encryption key pair on the owner's PC (`D:\vertex-digital-backup-key\`); round trip checked; public key in `deploy/backup-public.asc`
- [x] `vertexdigital-backup`: encrypt the backup to the public key, upload with rclone, compare SHA-1, touch `offsite-last`
- [x] Health check alerts on no verified copy in 26 hours; `provision.sh` installs rclone and the key
- [x] `docs/deployment.md`, `docs/open-questions.md` (Q1 resolved), `deploy/CLAUDE.md`
- [x] `pnpm verify`; reviewer (no blocking issue)
- [ ] PR and merge; deploy with `provision.sh`; one backup run now, its copy in the bucket
- [ ] Restore test on the owner's PC; launch checklist ticked; deploy log
