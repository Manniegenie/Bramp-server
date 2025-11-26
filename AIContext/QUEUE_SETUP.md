# Queue System Setup Guide

## Prerequisites

1. **Redis Server** - Required for queue system
   - Local: Install Redis locally
   - Cloud: Use Redis Cloud, AWS ElastiCache, or similar

2. **Dependencies** - Already added to `package.json`
   - `bullmq` - Job queue system
   - `ioredis` - Redis client (already installed)

## Installation Steps

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Setup Redis

**Option A: Local Redis (Development)**

```bash
# macOS
brew install redis
brew services start redis

# Ubuntu/Debian
sudo apt-get install redis-server
sudo systemctl start redis

# Windows
# Download from https://redis.io/download
# Or use WSL2 with Ubuntu
```

**Option B: Cloud Redis (Production - Recommended)**

1. Sign up for Redis Cloud (https://redis.com/try-free/)
2. Create a database
3. Get connection URL or host/port/password
4. Set environment variables (see Step 3)

### Step 3: Configure Environment Variables

Add to `.env`:

```env
# Redis Configuration (optional - defaults to localhost)
REDIS_URL=redis://localhost:6379
# OR use individual components:
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=  # Optional, only if Redis requires password
```

**For Production (Redis Cloud):**
```env
REDIS_URL=redis://:password@redis-12345.redis.cloud:12345
# OR
REDIS_HOST=redis-12345.redis.cloud
REDIS_PORT=12345
REDIS_PASSWORD=your_password_here
```

### Step 4: Verify Redis Connection

Test Redis connection:

```bash
# Local Redis
redis-cli ping
# Should return: PONG

# Or test with Node.js
node -e "const Redis = require('ioredis'); const r = new Redis(); r.ping().then(console.log).then(() => r.quit());"
```

### Step 5: Start Server

```bash
npm start
```

**Expected Output:**
```
✅ MongoDB Connected
✅ Redis initialized successfully for financial analysis queue
✅ Financial analysis workers started successfully
✅ Financial analysis queue system: ACTIVE
🔥 Server running on port 3000
```

**If Redis is not available:**
```
✅ MongoDB Connected
⚠️  Failed to initialize Redis/Queue system: Connection refused
⚠️  Financial analysis will fall back to direct processing
⚠️  Financial analysis queue system: FALLBACK (direct processing)
🔥 Server running on port 3000
```

## How It Works

### Queue System Flow

1. **Job Submission**:
   - User uploads bank and crypto statements
   - Job added to Redis queue
   - Returns job ID immediately

2. **Worker Processing**:
   - Worker picks up job from queue
   - Processes extraction using hybrid approach
   - Updates job progress (0-100%)
   - Automatically adds analysis job after extraction

3. **Analysis Processing**:
   - Analysis worker picks up analysis job
   - Processes analysis with GPT-4
   - Updates job status to "completed"
   - Saves report to database

4. **Frontend Polling**:
   - Frontend polls job status every 5 seconds
   - Receives progress updates
   - Displays report when complete

### Queue Features

- **Retry Mechanism**: 3 attempts with exponential backoff
- **Job Prioritization**: Extraction jobs priority 1, Analysis jobs priority 2
- **Progress Tracking**: Real-time progress updates (0-100%)
- **Error Handling**: Failed jobs saved to dead letter queue
- **Concurrency**: 2 jobs processed concurrently
- **Rate Limiting**: Max 5 jobs per second

### Fallback Mechanism

If Redis is not available:
- System falls back to direct processing
- Uses `financialAnalysisWorker.js` directly
- No queue, but still works
- Logs warning messages

## Monitoring

### Health Check

```bash
curl http://localhost:3000/financial-analysis/health
```

**Response:**
```json
{
  "healthy": true,
  "checks": {
    "database": { "healthy": true, "message": "Database is healthy" },
    "redis": { "healthy": true, "message": "Redis is healthy" },
    "openai": { "healthy": true, "message": "OpenAI API is healthy" },
    "system": { "healthy": true, "message": "System resources are healthy" }
  },
  "timestamp": "2025-11-12T18:00:00.000Z"
}
```

### Queue Status

Check queue status in logs:
- `Job X completed` - Job finished successfully
- `Job X failed: reason` - Job failed with error
- `Job X progress: X%` - Job progress update

### Redis Monitoring

```bash
# Connect to Redis CLI
redis-cli

# Check queue length
LLEN bull:financial-analysis:waiting

# Check failed jobs
LLEN bull:financial-analysis:failed

# Check completed jobs
LLEN bull:financial-analysis:completed
```

## Troubleshooting

### Redis Connection Failed

**Error**: `Connection refused` or `ECONNREFUSED`

**Solution**:
1. Check if Redis is running: `redis-cli ping`
2. Check Redis URL/host/port in `.env`
3. Check firewall settings
4. System will fall back to direct processing

### Jobs Not Processing

**Possible Causes**:
1. Workers not started
2. Redis connection lost
3. Job stuck in queue

**Solution**:
1. Check logs for worker errors
2. Check Redis connection
3. Restart server
4. Check job status in database

### Memory Issues

**Error**: `Out of memory` or crashes

**Solution**:
1. Reduce concurrency (change `concurrency: 2` to `concurrency: 1`)
2. Increase server memory
3. Process jobs sequentially
4. Check PDF size limits (500KB max)

## Performance Tuning

### Concurrency

Adjust in `financial-analysis/queue/workers.js`:
```javascript
concurrency: 2, // Process 2 jobs concurrently
```

### Rate Limiting

Adjust in `financial-analysis/queue/workers.js`:
```javascript
limiter: {
    max: 5, // Max 5 jobs
    duration: 1000, // Per second
},
```

### Retry Strategy

Adjust in `financial-analysis/queue/queues.js`:
```javascript
attempts: 3, // Number of retries
backoff: {
    type: "exponential",
    delay: 2000, // Start with 2 seconds
},
```

## Production Deployment

### Redis Cloud Setup

1. **Create Redis Cloud Account**
   - Sign up at https://redis.com
   - Create a free database (30MB free tier)

2. **Get Connection Details**
   - Copy connection URL
   - Or get host/port/password

3. **Set Environment Variables**
   ```env
   REDIS_URL=redis://:password@redis-12345.redis.cloud:12345
   ```

4. **Verify Connection**
   - Check health endpoint
   - Monitor logs for Redis connection

### Scaling

**Horizontal Scaling**:
- Run multiple worker processes
- Each process processes jobs from the same queue
- Redis coordinates job distribution

**Vertical Scaling**:
- Increase concurrency per worker
- Increase server memory
- Increase Redis memory

## Testing

### Test Queue System

1. **Upload Statements**:
   ```bash
   curl -X POST http://localhost:3000/financial-analysis/submit \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -F "bankFile=@bank.pdf" \
     -F "cryptoFile=@crypto.pdf"
   ```

2. **Check Job Status**:
   ```bash
   curl http://localhost:3000/financial-analysis/job/JOB_ID \
     -H "Authorization: Bearer YOUR_TOKEN"
   ```

3. **Check Health**:
   ```bash
   curl http://localhost:3000/financial-analysis/health
   ```

### Test Fallback

1. **Stop Redis**:
   ```bash
   # macOS
   brew services stop redis
   
   # Ubuntu
   sudo systemctl stop redis
   ```

2. **Restart Server**:
   - Should log: "Financial analysis queue system: FALLBACK"
   - Should still work with direct processing

## Next Steps

1. **Monitor Performance**: Check logs for job processing times
2. **Adjust Settings**: Tune concurrency and rate limits
3. **Scale Workers**: Add more worker processes if needed
4. **Monitor Redis**: Check Redis memory and connection
5. **Optimize**: Fine-tune retry strategy and timeouts

## Support

For issues:
1. Check logs in `logs/` directory
2. Check health endpoint
3. Check Redis connection
4. Check job status in database
5. Review error messages in job records


