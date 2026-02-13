#!/bin/bash
# Permanent fix for log file permissions on Contabo server
# Run this script on your server as chibuike user (or with sudo)

set -e

SERVER_DIR="/home/chibuike/bramp-server"
LOGS_DIR="${SERVER_DIR}/logs"
USER="chibuike"
GROUP="chibuike"

echo "🔧 Fixing log permissions for Bramp Server..."

# 1. Ensure logs directory exists and is owned by chibuike
echo "📁 Creating/fixing logs directory..."
mkdir -p "${LOGS_DIR}"
sudo chown -R ${USER}:${GROUP} "${LOGS_DIR}"
sudo chmod -R u+rwX "${LOGS_DIR}"

# 2. Fix ownership of any existing log files
echo "📝 Fixing ownership of existing log files..."
sudo chown -R ${USER}:${GROUP} "${LOGS_DIR}"/* 2>/dev/null || true
sudo chmod -R u+rw "${LOGS_DIR}"/* 2>/dev/null || true

# 3. Ensure PM2 runs as chibuike user
echo "🔄 Checking PM2 configuration..."
if command -v pm2 &> /dev/null; then
    # Save current PM2 processes
    pm2 save || true
    
    # Ensure PM2 startup script uses chibuike user
    echo "⚠️  If PM2 startup script exists, ensure it runs as ${USER}"
    echo "   Run: sudo env PATH=\$PATH:/usr/bin pm2 startup systemd -u ${USER} --hp /home/${USER}"
fi

# 4. Set proper permissions on the entire bramp-server directory
echo "🔐 Setting proper permissions on project directory..."
sudo chown -R ${USER}:${GROUP} "${SERVER_DIR}"
sudo find "${SERVER_DIR}" -type d -exec chmod 755 {} \;
sudo find "${SERVER_DIR}" -type f -exec chmod 644 {} \;
sudo chmod +x "${SERVER_DIR}/server.js" 2>/dev/null || true

# 5. Create a .env file or update it to disable file logging by default
ENV_FILE="${SERVER_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
    echo "📄 Creating .env file..."
    echo "# File logging disabled by default to prevent permission issues" > "${ENV_FILE}"
    echo "# Set ENABLE_FILE_LOG=true if you want file logging (after fixing permissions)" >> "${ENV_FILE}"
    echo "ENABLE_FILE_LOG=false" >> "${ENV_FILE}"
else
    # Update existing .env if ENABLE_FILE_LOG is not set or is true
    if ! grep -q "ENABLE_FILE_LOG" "${ENV_FILE}"; then
        echo "" >> "${ENV_FILE}"
        echo "# File logging disabled by default" >> "${ENV_FILE}"
        echo "ENABLE_FILE_LOG=false" >> "${ENV_FILE}"
    elif grep -q "ENABLE_FILE_LOG=true" "${ENV_FILE}"; then
        echo "⚠️  ENABLE_FILE_LOG is set to true in .env"
        echo "   Consider setting it to false until permissions are confirmed working"
    fi
fi

echo ""
echo "✅ Permissions fixed!"
echo ""
echo "📋 Next steps:"
echo "   1. Restart PM2: pm2 restart bramp-api"
echo "   2. Check logs: pm2 logs bramp-api --lines 50"
echo "   3. If you want file logging, set ENABLE_FILE_LOG=true in .env after confirming permissions work"
echo ""
echo "🔍 To verify permissions:"
echo "   ls -ld ${LOGS_DIR}"
echo "   touch ${LOGS_DIR}/test.log && rm ${LOGS_DIR}/test.log"
