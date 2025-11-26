# Facebook Conversions API Setup

## Environment Variables Required

Add these environment variables to your `.env` file:

```bash
# Facebook Conversions API Configuration
FACEBOOK_ACCESS_TOKEN=your_facebook_access_token_here
FACEBOOK_PIXEL_ID=your_facebook_pixel_id_here
FACEBOOK_TEST_EVENT_CODE=your_test_event_code_here_optional

# Client URL for event source URL
CLIENT_URL=https://priscaai.online
```

## How to Get Your Facebook Access Token

1. Go to [Facebook Business Manager](https://business.facebook.com/)
2. Navigate to **Events Manager**
3. Select your **Pixel**
4. Go to **Settings** → **Conversions API**
5. Click **Set up manually**
6. Click **Generate access token**
7. Copy the access token (starts with `EAAM...`)

## How to Get Your Pixel ID

1. In **Events Manager**
2. Select your **Pixel**
3. Go to **Settings**
4. Copy the **Pixel ID** (numeric value)

## Test Event Code (Optional)

1. In **Events Manager**
2. Go to **Test Events** tab
3. Copy the **Test Event Code** (for testing only)

## Events Tracked

### CompleteRegistration
- **Triggered**: When user successfully completes signup (after password/PIN setup)
- **Data Sent**:
  - Email (hashed with SHA-256)
  - Phone number (hashed with SHA-256)
  - Client IP address
  - User agent
  - Event timestamp
  - Currency: USD
  - Value: 1.00

## Testing

1. Set up test event code in environment variables
2. Complete a signup on your site
3. Check **Events Manager** → **Test Events** for real-time events
4. Check server logs for Facebook API responses

## Troubleshooting

- Check server logs for Facebook API errors
- Verify access token is valid and not expired
- Ensure pixel ID is correct
- Test with test event code first
- Check Facebook Business Manager for event delivery status
