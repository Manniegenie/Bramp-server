# Bramp-Server

A Node.js backend server for the Bramp chatbot trading platform. This server handles chatbot transactions, user management, and provides analytics for the Bramp admin dashboard.

## 🚀 Overview

Bramp-Server is the backend API for the Bramp chatbot trading platform. It manages:
- **Chatbot Transactions**: SELL and BUY operations for various tokens
- **User Management**: User registration, authentication, and verification
- **Analytics**: Dashboard statistics and transaction reporting
- **Admin Operations**: Administrative functions for platform management

## 📋 Features

### Core Functionality
- **Chatbot Transaction Management**: Handle SELL/BUY operations for crypto tokens
- **User Authentication**: Secure admin authentication with JWT tokens
- **Analytics Dashboard**: Comprehensive analytics for admin dashboard
- **User Management**: User registration, verification, and profile management
- **Real-time Data**: Live transaction monitoring and reporting

### Analytics Endpoints
- **Dashboard Analytics**: Overview statistics and metrics
- **Recent Transactions**: Paginated transaction history
- **Advanced Filtering**: Universal search and filter capabilities
- **Token Analytics**: Token-specific trading statistics

## 🛠️ Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Authentication**: JWT (JSON Web Tokens)
- **Security**: bcrypt for password hashing
- **Validation**: Input validation and sanitization

## 📁 Project Structure

```
Bramp-Server/
├── adminRoutes/           # Admin-specific routes
│   ├── analytics.js      # Analytics endpoints
│   ├── adminsign-in.js   # Admin authentication
│   ├── registeradmin.js  # Admin registration
│   └── usermanagement.js  # User management
├── models/               # Database models
│   ├── user.js          # User model
│   ├── transaction.js   # Transaction model
│   └── ChatbotTransaction.js # Chatbot transaction model
├── middleware/           # Custom middleware
├── services/            # Business logic services
├── routes/              # Public API routes
├── auth/                # Authentication utilities
└── server.js            # Main server file
```

## 🔧 Installation

### Prerequisites
- Node.js (v14 or higher)
- MongoDB (v4.4 or higher)
- npm or yarn

### Setup Instructions

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Bramp-Server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file in the root directory:
   ```env
   MONGODB_URI=mongodb://localhost:27017/bramp
   JWT_SECRET=your-jwt-secret-key
   PORT=3000
   NODE_ENV=development
   ```

4. **Start the server**
   ```bash
   npm start
   # or for development
   npm run dev
   ```

## 📚 API Endpoints

### Authentication
- `POST /adminsignin/signin` - Admin login
- `POST /adminsignin/logout` - Admin logout
- `POST /registeradmin` - Register new admin

### Analytics (Admin Only)
- `GET /analytics/dashboard` - Dashboard overview statistics
- `GET /analytics/recent-transactions` - Recent chatbot transactions
- `GET /analytics/filter` - Advanced filtering and search
- `GET /analytics/swap-pairs` - Token trading statistics

### User Management (Admin Only)
- `GET /usermanagement/users` - Get users with filtering
- `GET /usermanagement/summary` - User summary statistics
- `POST /usermanagement/disable-2fa` - Disable user 2FA
- `POST /usermanagement/create-new-admin` - Create new admin
- `POST /usermanagement/remove-password` - Remove user password
- `GET /usermanagement/fetch-wallets` - Fetch user wallets
- `POST /usermanagement/wipe-pending-balance` - Wipe pending balance
- `POST /usermanagement/generate-wallet-by-phone` - Generate wallet by phone
- `POST /usermanagement/regenerate-wallet-by-phone` - Regenerate wallet by phone

## 🗄️ Database Models

### User Model
```javascript
{
  username: String,
  email: String,
  firstname: String,
  lastname: String,
  phoneNumber: String,
  emailVerified: Boolean,
  bvnVerified: Boolean,
  chatbotTransactionVerified: Boolean,
  wallets: Object,
  bankAccounts: Array,
  createdAt: Date,
  updatedAt: Date
}
```

### ChatbotTransaction Model
```javascript
{
  userId: ObjectId,
  kind: String, // 'SELL' or 'BUY'
  status: String, // 'PENDING', 'CONFIRMED', 'PAID', 'EXPIRED', 'CANCELLED'
  token: String,
  sellAmount: Number,
  buyAmount: Number,
  receiveAmount: Number,
  expectedRate: Number,
  payoutSuccess: Boolean,
  collectionSuccess: Boolean,
  createdAt: Date,
  updatedAt: Date
}
```

## 🔐 Security Features

- **JWT Authentication**: Secure token-based authentication
- **Password Hashing**: bcrypt for secure password storage
- **Input Validation**: Comprehensive input sanitization
- **Admin Authorization**: Role-based access control
- **Rate Limiting**: API rate limiting for security
- **CORS Protection**: Cross-origin request security

## 📊 Analytics Features

### Dashboard Analytics
- **User Statistics**: Total users, verified users, chatbot users
- **Transaction Metrics**: Total trades, completed trades, pending trades
- **Volume Analytics**: Trading volume by token and timeframe
- **Success Rates**: Payout and collection success rates

### Advanced Filtering
- **Search Capabilities**: Search by user, transaction ID, or reference
- **Date Filtering**: Filter by date ranges
- **Status Filtering**: Filter by transaction status
- **User Verification**: Filter by user verification status
- **Amount Filtering**: Filter by transaction amounts
- **Token Filtering**: Filter by specific tokens

## 🚀 Deployment

### Production Setup
1. **Environment Variables**: Configure production environment variables
2. **Database**: Set up MongoDB cluster
3. **Security**: Configure SSL certificates
4. **Monitoring**: Set up logging and monitoring
5. **Scaling**: Configure load balancing if needed

### Docker Deployment
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

## 🔧 Development

### Running Tests
```bash
npm test
```

### Code Linting
```bash
npm run lint
```

### Database Seeding
```bash
npm run seed
```

## 📈 Monitoring & Logging

- **Error Logging**: Comprehensive error tracking
- **Performance Monitoring**: API response time monitoring
- **Database Monitoring**: MongoDB performance tracking
- **Security Logging**: Authentication and authorization logs

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

## 📄 License

This project is proprietary software. All rights reserved.

## 🆘 Support

For technical support or questions:
- Create an issue in the repository
- Contact the development team
- Check the documentation

## 🔄 Version History

- **v1.0.0** - Initial release with core functionality
- **v1.1.0** - Added analytics endpoints
- **v1.2.0** - Enhanced filtering capabilities
- **v1.3.0** - Improved security features

---

**Note**: This server is specifically designed for chatbot transactions and should not be used for regular trading operations. All endpoints require proper authentication and authorization.