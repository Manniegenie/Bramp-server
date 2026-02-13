# Deployment Guide

## Post-Git-Pull Setup

After pulling from git, run the setup script to fix permissions:

```bash
bash post-pull-setup.sh
pm2 restart bramp-api
```

Or manually:

```bash
# Fix logs directory permissions
sudo chown -R chibuike:chibuike logs/
sudo chmod -R u+rwX logs/

# Ensure file logging is disabled by default (prevents permission crashes)
if ! grep -q "ENABLE_FILE_LOG" .env; then
  echo "ENABLE_FILE_LOG=false" >> .env
fi

pm2 restart bramp-api
```

## File Logging

File logging is **disabled by default** to prevent permission crashes. The logger will:
- ✅ Always work with console logging (never crashes)
- ✅ Only enable file logging if `ENABLE_FILE_LOG=true` is set in `.env`
- ✅ Gracefully skip file logging if permissions fail (app continues running)

### To Enable File Logging (Optional)

1. Fix permissions first:
   ```bash
   sudo chown -R chibuike:chibuike logs/
   sudo chmod -R u+rwX logs/
   ```

2. Enable in `.env`:
   ```bash
   echo "ENABLE_FILE_LOG=true" >> .env
   ```

3. Restart:
   ```bash
   pm2 restart bramp-api
   ```

## PM2 Auto-Start on Reboot

To ensure PM2 starts automatically after server reboot:

```bash
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u chibuike --hp /home/chibuike
```
