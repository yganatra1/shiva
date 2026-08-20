ssh root@156.238.99.16 -p 32815 -i ~/.ssh/id_ed25519 \
'mkdir -p /workspace/shiva/backups/postgres /workspace/shiva/scripts'

rsync -avh --progress \
-e "ssh -p 32815 -i ~/.ssh/id_ed25519" \
~/ShivaBackup/postgres/ \
root@156.238.99.16:/workspace/shiva/backups/postgres/

rsync -avh --progress \
-e "ssh -p 32815 -i ~/.ssh/id_ed25519" \
~/ShivaBackup/scripts/ \
root@156.238.99.16:/workspace/shiva/scripts/

chown -R root:root /workspace/shiva/scripts /workspace/shiva/backups

chmod 755 /workspace/shiva/scripts/*.sh
chmod 644 /workspace/shiva/scripts/env.sh
chmod 644 /workspace/shiva/backups/postgres/*.dump