# Security Configuration Guide

## 🔒 Environment Variables Security

### Required Environment Variables
Create a `.env` file with the following variables (never commit this file):

```bash
# JWT Secrets (minimum 32 characters)
JWT_SECRET=your-super-secure-jwt-secret-key-here-minimum-32-chars
ADMIN_JWT_SECRET=your-super-secure-admin-jwt-secret-key-here-minimum-32-chars
REFRESH_JWT_SECRET=your-super-secure-refresh-jwt-secret-key-here-minimum-32-chars

# Frontend Storage Secret
VITE_SECURE_STORAGE_SECRET=your-super-secure-frontend-storage-secret-here-minimum-32-chars

# Facebook Integration
FACEBOOK_ACCESS_TOKEN=your_facebook_access_token_here
FACEBOOK_PIXEL_ID=your_facebook_pixel_id_here
FACEBOOK_TEST_EVENT_CODE=your_test_event_code_here

# API Configuration
CLIENT_URL=https://your-domain.com
API_BASE_URL=https://your-api-domain.com

# Database
MONGODB_URI=your_mongodb_connection_string

# External Services
OPENAI_API_KEY=your_openai_api_key
```

### Security Best Practices

1. **Never commit `.env` files to version control**
2. **Use strong, unique secrets (minimum 32 characters)**
3. **Rotate secrets regularly**
4. **Use different secrets for different environments**
5. **Store production secrets in secure vaults (AWS Secrets Manager, Azure Key Vault)**

## 🛡️ Security Features Implemented

### 1. Content Security Policy (CSP)
- Prevents XSS attacks
- Restricts resource loading
- Enforces HTTPS

### 2. Rate Limiting
- **General API**: 100 requests/15 minutes
- **Authentication**: 5 requests/15 minutes
- **Sensitive endpoints**: 10 requests/15 minutes
- **Webhooks**: 50 requests/15 minutes

### 3. Security Headers
- **HSTS**: Forces HTTPS connections
- **X-Frame-Options**: Prevents clickjacking
- **X-Content-Type-Options**: Prevents MIME sniffing
- **Referrer-Policy**: Controls referrer information

### 4. Authentication Security
- JWT tokens with expiration
- Automatic logout after 45 minutes
- Secure token storage with AES encryption
- Refresh token mechanism

### 5. Input Validation
- All user inputs are sanitized
- MongoDB injection protection via Mongoose
- XSS prevention in chat messages

### 6. Security Logging
- Failed authentication attempts logged
- Security-relevant endpoints monitored
- IP address and User-Agent tracking

## 🚨 Security Monitoring

Monitor these logs for security issues:
- `[SECURITY] Auth failure` - Failed login attempts
- `[SECURITY]` - Security-relevant endpoint access
- Rate limit violations
- CORS violations

## 🔧 Production Deployment Checklist

- [ ] Set all required environment variables
- [ ] Use HTTPS in production
- [ ] Configure proper CORS origins
- [ ] Set up security monitoring
- [ ] Regular security audits
- [ ] Keep dependencies updated
- [ ] Use secure secret management
- [ ] Enable security headers
- [ ] Monitor failed authentication attempts

## 📞 Security Incident Response

If you suspect a security breach:
1. Immediately rotate all secrets
2. Review security logs
3. Check for unauthorized access
4. Update security measures
5. Notify users if necessary
