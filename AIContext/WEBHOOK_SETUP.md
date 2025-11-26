# Extracta.ai Webhook Setup Guide

## Quick Setup

### 1. Set Environment Variables

Add to your `.env` file:

```env
# Extracta.ai API Key (required)
EXTRACTA_API_KEY=your_extracta_api_key_here

# Webhook Secret (optional - defaults to EXTRACTA_API_KEY if not set)
EXTRACTA_WEBHOOK_SECRET=your_webhook_secret_here

# Webhook URL (optional - defaults to https://priscaai.online/financial-analysis/extracta-webhook)
EXTRACTA_WEBHOOK_URL=https://priscaai.online/financial-analysis/extracta-webhook
```

### 2. Configure Webhook in Extracta.ai Dashboard

1. Log in to your Extracta.ai dashboard
2. Go to **Settings** → **Webhooks**
3. Add new webhook:
   - **URL**: `https://priscaai.online/financial-analysis/extracta-webhook`
   - **Secret**: Use your Extracta.ai API key (or webhook secret if provided)
   - **Events**: Enable `extraction.processed` and `extraction.failed`
4. Save the webhook configuration

### 3. Verify Webhook Secret

The webhook secret should be:
- Your Extracta.ai API key (most common)
- OR a separate webhook secret provided by Extracta.ai

**Important**: The code automatically removes the `E_AI_K_` prefix if present, so include the full secret value in your `.env` file.

### 4. Test the Webhook

1. Upload a statement through your application
2. Check server logs for webhook calls
3. Verify that the webhook signature is validated successfully

## How Webhook Validation Works

The webhook validation:
1. Receives the `x-webhook-signature` header from Extracta.ai
2. Uses `EXTRACTA_WEBHOOK_SECRET` (or `EXTRACTA_API_KEY` as fallback)
3. Removes `E_AI_K_` prefix if present
4. Computes HMAC SHA256 signature of the `result` array
5. Compares with the received signature
6. Validates the webhook if signatures match

## Troubleshooting

### Webhook signature validation fails

- **Check**: Is `EXTRACTA_WEBHOOK_SECRET` set correctly in `.env`?
- **Check**: Is the webhook secret in Extracta.ai dashboard the same as your API key?
- **Check**: Server logs will show both received and computed signatures for debugging

### Webhook not receiving events

- **Check**: Is the webhook URL correct in Extracta.ai dashboard?
- **Check**: Is your server accessible from the internet?
- **Check**: Are the webhook events enabled in Extracta.ai dashboard?
- **Check**: Server logs for incoming webhook requests

### Webhook secret not configured error

- **Check**: Is `EXTRACTA_API_KEY` set in your `.env` file?
- **Check**: If using a separate webhook secret, is `EXTRACTA_WEBHOOK_SECRET` set?

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EXTRACTA_API_KEY` | Yes | - | Your Extracta.ai API key |
| `EXTRACTA_WEBHOOK_SECRET` | No | `EXTRACTA_API_KEY` | Webhook secret for signature validation |
| `EXTRACTA_WEBHOOK_URL` | No | `https://priscaai.online/financial-analysis/extracta-webhook` | Webhook URL to notify Extracta.ai |

## Webhook Endpoint

**URL**: `https://priscaai.online/financial-analysis/extracta-webhook`

**Method**: `POST`

**Headers**: 
- `x-webhook-signature`: HMAC SHA256 signature of the result array

**Payload Format**:
```json
{
  "event": "extraction.processed",
  "result": [
    {
      "extractionId": "extraction_id",
      "status": "processed",
      "result": { /* extracted data */ }
    }
  ]
}
```

## Support

If you encounter issues:
1. Check server logs for detailed error messages
2. Verify webhook configuration in Extracta.ai dashboard
3. Test webhook signature validation locally
4. Contact Extracta.ai support if the secret is not working


