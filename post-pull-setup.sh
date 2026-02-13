#!/bin/bash
# Post-pull setup script - run after git pull to fix permissions
# Usage: bash post-pull-setup.sh

set -e

echo "🔧 Running post-pull setup..."

# Fix logs directory permissions
LOGS_DIR="./logs"
if [ -d "$LOGS_DIR" ]; then
    echo "📁 Fixing logs directory permissions..."
    sudo chown -R chibuike:chibuike "$LOGS_DIR" 2>/dev/null || chown -R chibuike:chibuike "$LOGS_DIR" 2>/dev/null || true
    sudo chmod -R u+rwX "$LOGS_DIR" 2>/dev/null || chmod -R u+rwX "$LOGS_DIR" 2>/dev/null || true
fi

# Ensure .env has ENABLE_FILE_LOG=false (file logging disabled by default)
if [ -f .env ]; then
    if ! grep -q "ENABLE_FILE_LOG" .env; then
        echo "📝 Adding ENABLE_FILE_LOG=false to .env..."
        echo "" >> .env
        echo "# File logging disabled by default to prevent permission issues" >> .env
        echo "ENABLE_FILE_LOG=false" >> .env
    fi
fi

echo "✅ Post-pull setup complete!"
echo ""
echo "💡 To restart PM2: pm2 restart bramp-api"
