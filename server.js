require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const morgan = require("morgan");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const cron = require("node-cron");

const { updateCryptoPrices } = require("./services/cryptoPriceJob");
const { markExpiredTransactions } = require("./services/transactionCleanup");
const { logger: financialLogger } = require("./financial-analysis/utils/logger");

// BULLETPROOF: Catch ALL errors from winston/file system that might crash the app
process.on('uncaughtException', (error) => {
  // If it's ANY file/logging error, ignore it and continue - NEVER crash from logging
  const isLoggingError = (
    (error.code === 'EACCES' || error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'EPERM') &&
    error.path && (
      error.path.includes('logs') || 
      error.path.includes('.log') ||
      error.message && error.message.includes('log')
    )
  ) || (
    error.message && (
      error.message.includes('winston') ||
      error.message.includes('DailyRotateFile') ||
      error.message.includes('log file') ||
      error.message.includes('permission denied') && error.message.includes('log')
    )
  );
  
  if (isLoggingError) {
    // Silently ignore logging errors - app continues with console logging
    return; // Don't crash the app
  }
  
  // For other uncaught exceptions, log and exit
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  // If it's ANY file/logging error, ignore it
  const isLoggingError = reason && (
    ((reason.code === 'EACCES' || reason.code === 'ENOENT' || reason.code === 'EPERM') &&
     reason.path && (
       reason.path.includes('logs') || 
       reason.path.includes('.log')
     )) ||
    (reason.message && (
      reason.message.includes('winston') ||
      reason.message.includes('DailyRotateFile') ||
      reason.message.includes('log file') ||
      reason.message.includes('permission denied') && reason.message.includes('log')
    ))
  );
  
  if (isLoggingError) {
    // Silently ignore logging errors - app continues
    return; // Don't crash the app
  }
  
  // For other unhandled rejections, log but don't exit (let the app continue)
  console.error('⚠️  Unhandled Rejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   CORS (multi-origin + wildcard + localhost)
   ========================= */
app.set("trust proxy", 1);

const splitList = (v = "") =>
  v
    .split(/[, \n\r\t]+/)                 // commas, spaces, newlines
    .map(s => s.trim().replace(/^"+|"+$/g, ""))
    .filter(Boolean);

const normalize = (o) => (o ? o.replace(/\/+$/, "") : o); // strip trailing slash

// 1) Exact origins
const exactOrigins = new Set(
  [
    process.env.CLIENT_URL,               // back-compat single
    ...splitList(process.env.CLIENT_URLS || "")
  ]
    .filter(Boolean)
    .map(normalize)
);

// Explicitly allow Vercel staging preview domain
// Note: trailing slashes are stripped by normalize()
exactOrigins.add(normalize("https://chatbotbramp-git-game-staging-manniegenies-projects.vercel.app"));

// Explicitly allow chatbramp.com and brampchat.online domains (production frontends)
// Add both normalized and non-normalized to ensure they're in the set
const chatbrampOrigins = [
  "https://chatbramp.com",
  "https://www.chatbramp.com",
  "https://brampchat.online",
  "https://www.brampchat.online",
];
chatbrampOrigins.forEach(origin => {
  exactOrigins.add(origin);
  exactOrigins.add(normalize(origin));
  // Also add without protocol normalization (just in case)
  exactOrigins.add(origin.toLowerCase());
  exactOrigins.add(origin.toUpperCase());
});


// 2) Auto add www / non-www counterparts (helps avoid near-misses)
for (const url of [...exactOrigins]) {
  try {
    const u = new URL(url);
    const alt = new URL(url);
    if (u.hostname.startsWith("www.")) {
      alt.hostname = u.hostname.replace(/^www\./, "");
    } else {
      alt.hostname = "www." + u.hostname;
    }
    exactOrigins.add(normalize(alt.toString()));
  } catch { }
}

// 3) Wildcards
const wildcardPatterns = splitList(process.env.CORS_WILDCARDS || "");
const wildcardRegexes = wildcardPatterns.map((pat) => {
  // "*.chatbramp.com" -> /^https?:\/\/([a-z0-9-]+\.)?chatbramp\.com(?::\d+)?$/i
  const host = pat.replace(/\./g, "\\.").replace(/^\*\./, "([a-z0-9-]+\\.)?");
  return new RegExp(`^https?:\/\/${host}(?::\\d+)?$`, "i");
});

function isAllowed(origin) {
  if (!origin) return true;                    // allow curl/webhooks
  const o = normalize(origin);
  if (exactOrigins.has(o)) return true;

  // Allow all localhost and 127.0.0.1 (with any port) for development
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return true;

  const matched = wildcardRegexes.some(rx => rx.test(o));

  // Debug logging for CORS issues
  if (process.env.NODE_ENV !== 'production' && !matched) {
    console.log(`[CORS Debug] Origin: ${origin}, Normalized: ${o}, Allowed: ${matched}`);
    console.log(`[CORS Debug] Exact origins:`, [...exactOrigins]);
  }

  return matched;
}

const corsOptions = {
  origin(origin, cb) {
    if (isAllowed(origin)) {
      return cb(null, true);
    }
    return cb(new Error(`CORS: origin not allowed → ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "x-obiex-signature"],
  exposedHeaders: ["Content-Length", "Content-Type"],
  credentials: true,
  optionsSuccessStatus: 204,
  maxAge: 86400
};

// Apply CORS middleware - MUST be before other middleware
app.use(require("cors")(corsOptions));

// Logging & Security
app.use(morgan("combined"));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://embed.tawk.to", "https://connect.facebook.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.openai.com", "https://priscaai.online"],
      frameSrc: ["'self'", "https://embed.tawk.to"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  xFrameOptions: { action: 'deny' },
  xContentTypeOptions: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Security: Block common scanner paths early (before other middleware)
const suspiciousPaths = [
  '/.env', '/.env.prod', '/.env.production', '/.env.dev', '/.env.local',
  '/aws_keys', '/awsconfigura', '/awstats', '/boot', '/cgi-bin', '/cloud/aws',
  '/config/aws', '/configura/aws', '/core/aws', '/cron', '/env', '/sources',
  '/v1/.env', '/js/.env', '/run/.env', '/proc/.env', '/admin/.env',
  '/wp-admin', '/wp-login', '/phpmyadmin', '/.git', '/.svn', '/.htaccess',
  '/backup', '/backups', '/config.php', '/database.sql', '/dump.sql'
];

app.use((req, res, next) => {
  const path = req.path.toLowerCase();

  // Block suspicious paths immediately
  if (suspiciousPaths.some(suspicious => path.includes(suspicious.toLowerCase()))) {
    // Silently return 404 without logging (reduces log noise from scanners)
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  next();
});

// Security logging middleware
app.use((req, res, next) => {
  // Log security-relevant events
  if (req.path.includes('/admin') || req.path.includes('/auth') || req.path.includes('/webhook')) {
    console.log(`[SECURITY] ${req.method} ${req.path} - IP: ${req.ip} - User-Agent: ${req.get('User-Agent')}`);
  }

  // Log failed authentication attempts
  const originalSend = res.send;
  res.send = function (data) {
    if (res.statusCode === 401 || res.statusCode === 403) {
      console.log(`[SECURITY] Auth failure: ${req.method} ${req.path} - IP: ${req.ip} - Status: ${res.statusCode}`);
    }
    return originalSend.call(this, data);
  };

  next();
});

// Raw body capture middleware for webhook signature validation
app.use(['/Chatbotwebhook', '/webhook', '/billwebhook', '/ngnbwebhook', '/whatsapp', '/tawk'], (req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    data += chunk;
  });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// Body parsers - limit for file uploads (200KB limit per file)
app.use(express.json({ limit: '1mb' })); // Reduced since files are limited to 200KB
app.use(express.urlencoded({ limit: '1mb', extended: true }));

// General rate limiter for all routes (prevents abuse)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // 500 requests per 15 minutes per IP
  message: { success: false, error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks, webhooks, and job status polling
    // Job status polling needs frequent checks (every 5 seconds) and is read-only
    const path = req.path.toLowerCase();
    return path === '/' ||
      path === '/health' ||
      path.startsWith('/financial-analysis/health') ||
      path.includes('webhook') ||
      path.match(/^\/financial-analysis\/job\/[a-f0-9]{32,}$/i); // Job status polling endpoint (32+ hex chars)
  }
});

// Apply general rate limiter to all routes
app.use(generalLimiter);

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: "Too many requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false
});

// Strict rate limiter for sensitive endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: "Too many requests to sensitive endpoint" },
  standardHeaders: true,
  legacyHeaders: false
});

// Auth-specific rate limiter
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: "Too many authentication attempts" },
  standardHeaders: true,
  legacyHeaders: false
});

// Frontend rate limiting disabled to avoid 429s for public endpoints

const webhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { success: false, error: "Too many webhook requests, please try again later" },
  standardHeaders: true,
  legacyHeaders: false
});

// Auth
app.use(passport.initialize());

// Regular user authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, error: "Unauthorized: No token provided." });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: "Forbidden: Invalid token." });
    req.user = user;
    next();
  });
};

// Simplified Admin authentication middleware
const authenticateAdminToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized: No admin token provided."
    });
  }

  jwt.verify(token, process.env.ADMIN_JWT_SECRET, (err, admin) => {
    if (err) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: Invalid admin token."
      });
    }

    req.admin = admin;
    next();
  });
};

// Role-specific middlewares
const requireSuperAdmin = (req, res, next) => {
  if (req.admin.adminRole !== 'super_admin') {
    return res.status(403).json({
      success: false,
      error: "Super admin access required."
    });
  }
  next();
};

const requireAdmin = (req, res, next) => {
  if (!['admin', 'super_admin'].includes(req.admin.adminRole)) {
    return res.status(403).json({
      success: false,
      error: "Admin access required."
    });
  }
  next();
};

const requireModerator = (req, res, next) => {
  if (!['moderator', 'admin', 'super_admin'].includes(req.admin.adminRole)) {
    return res.status(403).json({
      success: false,
      error: "Moderator access required."
    });
  }
  next();
};

// Permission-based middleware
const requirePermission = (permission) => {
  return async (req, res, next) => {
    try {
      const AdminUser = require('./models/admin');
      const adminId = req.admin.id || req.admin._id;

      const adminUser = await AdminUser.findById(adminId);

      if (!adminUser) {
        return res.status(403).json({ success: false, error: "Admin user not found." });
      }

      if (adminUser.role === 'super_admin') {
        return next();
      }

      const roleBasedPermissions = {
        admin: {
          canManagePushNotifications: true,
          canManageUsers: true,
          canManageBanners: true,
          canManageGiftcards: true,
          canManageKYC: true,
        },
        moderator: {
          canViewTransactions: true,
          canAccessReports: true,
        }
      };

      if (adminUser.role === 'admin' && roleBasedPermissions.admin[permission]) {
        return next();
      }
      if (adminUser.role === 'moderator' && roleBasedPermissions.moderator[permission]) {
        return next();
      }

      if (req.admin.permissions && req.admin.permissions[permission] === true) {
        return next();
      }

      if (adminUser.hasPermission && adminUser.hasPermission(permission)) {
        return next();
      }

      return res.status(403).json({ success: false, error: `Permission denied: ${permission} required.` });

    } catch (error) {
      console.error('Error checking permission:', error);
      return res.status(500).json({ success: false, error: "Internal server error checking permissions." });
    }
  };
};

const requirePushNotifications = requirePermission('canManagePushNotifications');
const requireUserManagement = requirePermission('canManageUsers');
const requireKYCReview = requirePermission('canManageKYC');
const requireGiftcards = requirePermission('canManageGiftcards');
const requireBanners = requirePermission('canManageBanners');
const requireRemoveFunding = requirePermission('canRemoveFunding');
const requireManageBalances = requirePermission('canManageBalances');

// Routes
const avatarsRoutes = require("./routes/avatars");
const logoutRoutes = require("./routes/logout");
const refreshtokenRoutes = require("./routes/refreshtoken");
const passwordpinRoutes = require("./routes/passwordpin");
const transactionpinRoutes = require("./routes/transactionpin");
const signinRoutes = require("./routes/signin");
const signupRoutes = require("./routes/signup");
const usernameRoutes = require("./routes/username");
const balanceRoutes = require("./routes/balance");
const webhookRoutes = require("./routes/obiexwebhooktrx");
const depositRoutes = require("./routes/deposit");
const deleteuserRoutes = require("./adminRoutes/deleteuser");
const SetfeeRoutes = require("./adminRoutes/cryptofee");
const verifyotpRoutes = require("./routes/verifyotp");
const usernamecheckRoutes = require("./routes/usernamecheck");
const withdrawRoutes = require("./routes/withdraw");
const validatewithdrawRoutes = require("./routes/validate-balance");
const updateuseraddressRoutes = require("./adminRoutes/updatewalletaddress");
const generatebrampwalletsRoutes = require("./adminRoutes/generatebrampwallets");
const fetchrefreshtoken = require("./adminRoutes/refresh-token");
const FunduserRoutes = require("./adminRoutes/funduser");
const clearpendingRoutes = require("./adminRoutes/pendingbalance");
const fetchwalletRoutes = require("./adminRoutes/fetchwallet");
const fetchtransactionRoutes = require("./adminRoutes/fetchtransactions");
const deletepinRoutes = require("./adminRoutes/deletepin");
const nairaPriceRouter = require("./routes/nairaprice");
const markupRouter = require("./adminRoutes/onramp");
const markdownRouter = require("./adminRoutes/offramp");
const unlockaccountRoutes = require("./adminRoutes/unlockaccount");
const fetchuserRoutes = require("./adminRoutes/fetchuser");
const walletRoutes = require("./routes/wallet");
const TwoFARoutes = require("./auth/setup-2fa");
const AirtimeRoutes = require("./routes/airtime");
const DataRoutes = require("./routes/data");
const VerifybillRoutes = require("./routes/verifybill");
const ElectricityRoutes = require("./routes/electricity");
const BettingRoutes = require("./routes/betting");
const CableTVRoutes = require("./routes/cabletv");
const fetchdataplans = require("./routes/dataplans");
const billwebhookRoutes = require("./routes/billwebhook");
const DashboardRoutes = require("./routes/dashboard");
const SwapRoutes = require("./routes/swap");
const verifypasswordpinRoutes = require("./routes/verifypasswordpin");
const migrationRoutes = require("./adminRoutes/updatekyc");
const historyRoutes = require("./routes/transactionhistory");
const internaltransferRoutes = require("./routes/usernamewithdraw");
const usernamequeryRoutes = require("./routes/usernamequery");
const ngnbwithdrawRoutes = require("./routes/nairawithdrawal");
const ngnbwebhookRoutes = require("./routes/nairawebhook");
const dollarvalueRoutes = require("./routes/dollarvalue");
const resendOtpRoutes = require("./routes/resendOtp");
const CableplanRoutes = require("./routes/cablepackages");
const AddressplanRoutes = require("./routes/ActiveAddress");
const pricemarkdownRoutes = require("./adminRoutes/pricemarkdown");
const admingiftcardRoutes = require("./adminRoutes/giftcard");
const giftcardRoutes = require("./routes/giftcard");
const giftcardRatesRoutes = require("./routes/giftcardrates");
const changepinRoutes = require("./routes/changepasswordpin");
const forgotpinRoutes = require("./routes/forgotpasswordpin");
const deleteaccountRoutes = require("./routes/deleteaccount");
const verifyemailRoutes = require("./routes/verifyemail");
const bankenquiryRoutes = require("./routes/BankEnquiry");
const bankaccountRoutes = require("./routes/BankAccount");
const profileRoutes = require("./routes/Profile");
const VerificationLevelRoutes = require("./routes/VerificationLevel");
const VerificationProcessRoutes = require("./routes/VerificationProcess");
const whatsappAIRoutes = require("./AI/whatsapp");
const ChatbotRoutes = require("./AI/Chatbot");
const ChatbotwebhookRoutes = require("./routes/chatbotwebhook");
const SellRoutes = require("./routes/sell");
const LightningSwapRoutes = require("./routes/lightning-swap");
const fetchnairaRoutes = require("./routes/fetchnaira");
const chatsignupRoutes = require("./routes/chatsignup");
const chatbotKYCRoutes = require("./routes/ChatbotKYC");
const ratesRoutes = require("./routes/Rates");
const ObiexRateRoutes = require("./adminRoutes/obiexRate");
const BuyRoutes = require("./routes/buy");
const AccountnameRoutes = require("./routes/Accountname");
const ChatbottransactionHistoryRoutes = require("./routes/ChatbottransactionHistory");
const SmileIDRedirectRoutes = require("./routes/SmileIDRedirect");
const PricesRoutes = require("./routes/prices");
const GameRoutes       = require("./routes/game");
const BetaMarketRoutes = require("./routes/betamarket");
const ScanRoutes       = require("./routes/scan");
const VoiceRoutes = require("./routes/voice");
const adminsigninRoutes = require("./adminRoutes/adminsign-in");
const adminRegisterRoutes = require("./adminRoutes/registeradmin");
const usermanagementRoutes = require("./adminRoutes/usermanagement");
const analyticsRoutes = require("./adminRoutes/analytics");
const marketingStatsRoutes = require("./adminRoutes/marketingStats");
const transactionDetailsRoutes = require("./adminRoutes/transactionDetails");
const permissionsRoutes = require("./adminRoutes/permissions");
const adminBlogRoutes = require("./adminRoutes/blog");
const AdminDisableTwoFARoutes = require("./adminRoutes/2FA");
const Admin2FARoutes = require("./adminRoutes/Admin2FA");
const adminBannerRoutes = require("./adminRoutes/banners");
const blockuserRoutes = require("./adminRoutes/blockuser");
const Pushnotification = require("./adminRoutes/pushnotification");
const AdminKYCRoutes = require("./adminRoutes/kyc");
const scheduledNotificationRoutes = require("./adminRoutes/scheduledNotifications");
const scheduledGiftCardNotificationRoutes = require("./adminRoutes/scheduledGiftCardNotifications");
const nairamarkupRoutes = require("./adminRoutes/nairamarkup");
const swapmarkdownRoutes = require("./adminRoutes/swapmarkdown");
const financialAnalysisRoutes = require("./routes/financialAnalysis");
const financialAnalysisWebhookRoutes = require("./routes/financialAnalysisWebhook");
const liskWalletRoutes = require("./routes/liskWallet");
const newsRoutes = require("./routes/news");
const notificationsRoutes = require("./routes/notifications");
const verificationProgressRoutes = require("./routes/VerificationProgress");
const blogRoutes = require("./routes/blog");
const tokenPricesRoutes = require("./routes/tokenPrices");
const bannersRoutes = require("./routes/Banners");
const collectionsRoutes = require("./routes/collections");
const giftcardcountryRoutes = require("./routes/giftcardcountry");
const fetchnetworkRoutes = require("./routes/fetchnetwork");
const tawkRoutes = require("./routes/tawk");
const debugRoutes = require("./routes/debug");
const resetPinRoutes = require("./routes/ResetPin");
const emailVerifyRoutes = require("./routes/EmailVerify");
const kycRoutes = require("./routes/KYC");
const enhancedKycRoutes = require("./routes/EnhancedKYC");
const ninRoutes = require("./routes/NIN");

// Public routes (with auth rate limiting)
app.use("/signin", signinRoutes);
app.use("/signup", signupRoutes);
app.use("/refresh-token", refreshtokenRoutes);
app.use("/verify-otp", verifyotpRoutes);
app.use("/passwordpin", passwordpinRoutes);
app.use("/usernamecheck", usernamecheckRoutes);
app.use("/verifypin", verifypasswordpinRoutes);
app.use("/chatsignup", chatsignupRoutes);
app.use("/prices", PricesRoutes);
app.use("/adminsignin", adminsigninRoutes);
// Public admin 2FA setup/verify routes (auth via email+PIN, no token required)
app.use("/admin-2fa", Admin2FARoutes);

// Webhooks (rate-limited)
app.use("/webhook", webhookLimiter, webhookRoutes);
app.use("/billwebhook", webhookLimiter, billwebhookRoutes);
app.use("/ngnbwebhook", webhookLimiter, ngnbwebhookRoutes);
app.use("/whatsapp", webhookLimiter, whatsappAIRoutes);
app.use("/chatbot", ChatbotRoutes); // Removed rate limiter - user-facing chat endpoint
app.use("/Chatbotwebhook", webhookLimiter, ChatbotwebhookRoutes);

// MODERATOR LEVEL ROUTES (all admin roles can access)
// IMPORTANT: More specific /admin/* routes must come BEFORE /admin to avoid conflicts
app.use("/admin/transaction", authenticateAdminToken, requireModerator, transactionDetailsRoutes);
app.use("/admin/permissions", authenticateAdminToken, permissionsRoutes);
app.use("/admin/blog", authenticateAdminToken, requireAdmin, adminBlogRoutes);
app.use("/admin/banners", authenticateAdminToken, requireAdmin, requireBanners, adminBannerRoutes);
app.use("/admin/notification", authenticateAdminToken, requireAdmin, requirePushNotifications, Pushnotification);
app.use("/admin/scheduled-notifications", authenticateAdminToken, requireAdmin, requirePushNotifications, scheduledNotificationRoutes);
app.use("/admin/scheduled-giftcard-notifications", authenticateAdminToken, requireAdmin, requirePushNotifications, scheduledGiftCardNotificationRoutes);
app.use("/admin/2FA", authenticateAdminToken, requireModerator, Admin2FARoutes);
app.use("/fetch-wallet", authenticateAdminToken, requireModerator, fetchwalletRoutes);
app.use("/fetch", authenticateAdminToken, requireModerator, fetchtransactionRoutes);
app.use("/pending", authenticateAdminToken, requireModerator, clearpendingRoutes);
app.use("/fetching", authenticateAdminToken, requireModerator, fetchrefreshtoken);
app.use("/fetchuser", authenticateAdminToken, requireModerator, fetchuserRoutes);
app.use("/usermanagement", authenticateAdminToken, requireModerator, requireUserManagement, usermanagementRoutes);
app.use("/analytics", authenticateAdminToken, requireModerator, marketingStatsRoutes); // marketing-stats: moderators+
app.use("/analytics", authenticateAdminToken, requireModerator, analyticsRoutes);
app.use("/2FA-Disable", authenticateAdminToken, requireModerator, AdminDisableTwoFARoutes);
app.use("/admin-kyc", authenticateAdminToken, requireModerator, AdminKYCRoutes);

// SUPER ADMIN ONLY ROUTES (highest permissions)
app.use("/deleteuser", authenticateAdminToken, requireSuperAdmin, deleteuserRoutes);
app.use("/fund", authenticateAdminToken, requireSuperAdmin, FunduserRoutes);
app.use("/unlockaccount", authenticateAdminToken, requireSuperAdmin, unlockaccountRoutes);
app.use("/delete-pin", authenticateAdminToken, requireSuperAdmin, deletepinRoutes);
// IMPORTANT: /admin must be LAST to avoid catching /admin/* routes above
app.use("/admin", adminRegisterRoutes);

// ADMIN LEVEL ROUTES (admin + super_admin)
app.use("/set-fee", authenticateAdminToken, requireAdmin, SetfeeRoutes);
app.use("/onramp", authenticateAdminToken, requireAdmin, markupRouter);
app.use("/offramp", markdownRouter);
app.use("/obiex-rate", authenticateAdminToken, requireAdmin, ObiexRateRoutes);
app.use("/updateuseraddress", authenticateAdminToken, requireAdmin, updateuseraddressRoutes);
app.use("/bramp-wallets", generatebrampwalletsRoutes);
app.use("/migration", authenticateAdminToken, requireAdmin, migrationRoutes);
app.use("/marker", authenticateAdminToken, requireAdmin, pricemarkdownRoutes);
app.use("/admingiftcard", authenticateAdminToken, requireAdmin, requireGiftcards, admingiftcardRoutes);
app.use("/notification", Pushnotification);
app.use("/block-user", authenticateAdminToken, requireAdmin, blockuserRoutes);
app.use("/nairamarkup", authenticateAdminToken, requireAdmin, nairamarkupRoutes);
app.use("/swapmarkdown", authenticateAdminToken, requireAdmin, swapmarkdownRoutes);

// Public data
app.use("/naira-price", nairaPriceRouter);
app.use("/addressplan", AddressplanRoutes);
app.use("/resend-otp", resendOtpRoutes);
app.use("/fetchnaira", fetchnairaRoutes);
app.use("/rates", ratesRoutes);
app.use("/accountname", AccountnameRoutes);
app.use("/news", newsRoutes);

// Protected user routes
app.use("/avatar-update", authenticateToken, avatarsRoutes);
app.use("/logout", authenticateToken, logoutRoutes);
app.use("/username", authenticateToken, usernameRoutes);
app.use("/balance", authenticateToken, balanceRoutes);
app.use("/deposit", authenticateToken, depositRoutes);
app.use("/wallet", authenticateToken, walletRoutes);
app.use("/withdraw", authenticateToken, withdrawRoutes);
app.use("/validate-balance", authenticateToken, validatewithdrawRoutes);
app.use("/transactionpin", authenticateToken, transactionpinRoutes);
app.use("/2FA", authenticateToken, TwoFARoutes);
app.use("/plans", authenticateToken, fetchdataplans);
app.use("/airtime", authenticateToken, AirtimeRoutes);
app.use("/data", authenticateToken, DataRoutes);
app.use("/verifybill", authenticateToken, VerifybillRoutes);
app.use("/electricity", authenticateToken, ElectricityRoutes);
app.use("/betting", authenticateToken, BettingRoutes);
app.use("/cabletv", authenticateToken, CableTVRoutes);
app.use("/packages", authenticateToken, CableplanRoutes);
app.use("/api", authenticateToken, DashboardRoutes);
app.use("/swap", authenticateToken, SwapRoutes);
app.use("/history", authenticateToken, historyRoutes);
app.use("/transfer", authenticateToken, internaltransferRoutes);
app.use("/query", authenticateToken, usernamequeryRoutes);
app.use("/ngnbwithdraw", authenticateToken, ngnbwithdrawRoutes);
app.use("/dollarvalue", authenticateToken, dollarvalueRoutes);
app.use("/giftcard", authenticateToken, giftcardRoutes);
app.use("/giftcardrates", authenticateToken, giftcardRatesRoutes);
app.use("/changepin", authenticateToken, changepinRoutes);
app.use("/forgotpin", forgotpinRoutes);
app.use("/deleteaccount", authenticateToken, deleteaccountRoutes);
app.use("/verifyemail", authenticateToken, verifyemailRoutes);
app.use("/bankenquiry", authenticateToken, bankenquiryRoutes);
app.use("/bankaccount", authenticateToken, bankaccountRoutes);
app.use("/profile", authenticateToken, profileRoutes);
app.use("/level", authenticateToken, VerificationLevelRoutes);
app.use("/process", authenticateToken, VerificationProcessRoutes);
app.use("/sell", authenticateToken, SellRoutes);
app.use("/swap", LightningSwapRoutes);
app.use("/buy", authenticateToken, BuyRoutes);
app.use("/chat-history", authenticateToken, ChatbottransactionHistoryRoutes);
app.use("/smileid-redirect", SmileIDRedirectRoutes);
app.use("/chatbot-kyc", authenticateToken, chatbotKYCRoutes);
app.use("/game",       authenticateToken, GameRoutes);
app.use("/betamarket", authenticateToken, BetaMarketRoutes);
app.use("/scan",       authenticateToken, ScanRoutes);
app.use("/voice", authenticateToken, VoiceRoutes);
app.use("/lisk", authenticateToken, liskWalletRoutes);
app.use("/notifications", authenticateToken, notificationsRoutes);
// Verification progress
app.use("/verification-progress", authenticateToken, verificationProgressRoutes);
// Collections (Glyde payment)
app.use("/collections", authenticateToken, collectionsRoutes);
// Email OTP verification
app.use("/email-verify", authenticateToken, emailVerifyRoutes);
// KYC routes
app.use("/kyc", authenticateToken, kycRoutes);
app.use("/enhanced-kyc", authenticateToken, enhancedKycRoutes);
app.use("/nin", authenticateToken, ninRoutes);
// Reset PIN (3-step: initiate OTP → verify OTP → change pin with 2FA)
app.use("/reset-pin", authenticateToken, resetPinRoutes);
// Public data routes
app.use("/blog", blogRoutes);
app.use("/token-prices", tokenPricesRoutes);
app.use("/banners", bannersRoutes);
app.use("/giftcardcountry", giftcardcountryRoutes);
app.use("/networks", fetchnetworkRoutes);
// Webhooks
app.use("/tawk", tawkRoutes);
// Debug (restrict to non-production)
if (process.env.NODE_ENV !== 'production') {
  app.use("/debug", debugRoutes);
}
// Financial analysis routes (health is public, process requires auth)
// Webhook endpoint is public (validated by signature), other endpoints require auth
app.use("/financial-analysis", financialAnalysisRoutes);
app.use("/financial-analysis", financialAnalysisWebhookRoutes);

// Health
app.get("/", (_req, res) => {
  res.send(`🚀 API Running at ${new Date().toISOString()}`);
});

// Error handler - CORS middleware should handle headers, but set them here as fallback
app.use((err, req, res, next) => {
  console.error("[ERROR] Unhandled error:", err.message);

  // Set CORS headers on error responses (fallback in case CORS middleware didn't run)
  const origin = req.headers.origin;
  if (origin && isAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      error: "CORS policy violation"
    });
  }

  const statusCode = err.status || err.statusCode || 500;
  const errorMessage = process.env.NODE_ENV === 'production'
    ? "Internal Server Error"
    : err.message || "Internal Server Error";

  res.status(statusCode).json({
    success: false,
    error: errorMessage
  });
});

// Cron jobs disabled per new requirements

// Initialize Redis and workers for financial analysis queue (optional, with graceful fallback)
let financialAnalysisWorker = null;
let redisInitialized = false;

async function initializeFinancialAnalysisQueue() {
  try {
    const { initializeRedis } = require("./financial-analysis/queue/redis");
    const { createExtractionWorker } = require("./financial-analysis/queue/workers");

    // Initialize Redis connection
    await initializeRedis();
    redisInitialized = true;
    financialLogger.info("✅ Redis initialized successfully for financial analysis queue");

    // Start workers
    financialAnalysisWorker = createExtractionWorker();
    financialLogger.info("✅ Financial analysis workers started successfully");

    return true;
  } catch (error) {
    financialLogger.warn("⚠️  Failed to initialize Redis/Queue system:", error.message);
    financialLogger.warn("⚠️  Financial analysis will fall back to direct processing");
    redisInitialized = false;
    return false;
  }
}

// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
  console.log(`${signal} received, shutting down gracefully...`);

  // Close MongoDB connection
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      console.log("✅ MongoDB connection closed");
    }
  } catch (error) {
    console.error("Error closing MongoDB connection:", error);
  }

  if (financialAnalysisWorker) {
    try {
      await financialAnalysisWorker.close();
      console.log("✅ Financial analysis workers closed");
    } catch (error) {
      console.error("Error closing workers:", error);
    }
  }

  try {
    const { closeRedis } = require("./financial-analysis/queue/redis");
    await closeRedis();
    console.log("✅ Redis connections closed");
  } catch (error) {
    // Redis might not be initialized, ignore
  }

  process.exit(0);
};

// MongoDB connection event handlers
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected. Attempting to reconnect...');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connection established');
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Start
const startServer = async () => {
  try {
    // Validate MONGODB_URI exists
    if (!process.env.MONGODB_URI) {
      console.error("❌ ERROR: MONGODB_URI environment variable is not set!");
      console.error("Please set MONGODB_URI in your .env file");
      process.exit(1);
    }

    // MongoDB connection options with timeout and retry
    const mongooseOptions = {
      serverSelectionTimeoutMS: 10000, // 10 seconds timeout
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      retryWrites: true,
      retryReads: true,
    };

    console.log("🔄 Attempting to connect to MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI, mongooseOptions);
    console.log("✅ MongoDB Connected");

    // Initialize financial analysis queue (non-blocking, with fallback)
    initializeFinancialAnalysisQueue().then(success => {
      if (success) {
        console.log("✅ Financial analysis queue system: ACTIVE");
      } else {
        console.log("⚠️  Financial analysis queue system: FALLBACK (direct processing)");
      }
    }).catch(err => {
      console.error("⚠️  Error initializing financial analysis queue:", err.message);
      console.log("⚠️  Financial analysis queue system: FALLBACK (direct processing)");
    });

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🔥 Server running on port ${PORT}`);
      console.log("Allowed exact origins:", [...exactOrigins].join(", ") || "(none)");
      console.log("Allowed wildcard patterns:", wildcardPatterns.join(", ") || "(none)");
      console.log("🏠 Localhost and 127.0.0.1 (all ports) automatically allowed for development");
      console.log("⏰ Crypto price update job scheduled every 15 minutes");

      // Schedule crypto price updates every 15 minutes
      cron.schedule('*/15 * * * *', async () => {
        console.log("⏰ Running scheduled crypto price update...");
        try {
          const result = await updateCryptoPrices();
          console.log("Scheduled price update result:", result);
        } catch (err) {
          console.error("Scheduled price update failed:", err.message);
        }
      });

      // Run initial price update manually
      setTimeout(() => {
        console.log("Running initial crypto price update...");
        updateCryptoPrices().then(result => {
          console.log("Initial price update result:", result);
        }).catch(err => {
          console.error("Initial price update failed:", err.message);
        });
      }, 5000);

      // Start scheduled notification services
      try {
        const scheduledNotificationService = require('./services/scheduledNotificationService');
        const scheduledGiftCardNotificationService = require('./services/scheduledGiftCardNotificationService');
        scheduledNotificationService.start();
        scheduledGiftCardNotificationService.start();
        console.log("📢 Scheduled notification services started");
      } catch (notifErr) {
        console.error("⚠️  Error starting scheduled notification services:", notifErr.message);
      }

      // Start BetaMarket prediction settlement + position crons
      try {
        const betamarketCron = require('./services/betamarketCron');
        betamarketCron.start();
        console.log("📊 BetaMarket cron started");
      } catch (cronErr) {
        console.error("⚠️  Error starting BetaMarket cron:", cronErr.message);
      }

      // Start Hyperliquid balance guard (hourly)
      try {
        const hlBalanceGuard = require('./services/hlBalanceGuard');
        hlBalanceGuard.start();
        console.log("🛡️  HL balance guard started");
      } catch (cronErr) {
        console.error("⚠️  Error starting HL balance guard:", cronErr.message);
      }
    });
  } catch (e) {
    console.error("❌ ERROR during startup:");
    console.error("Error message:", e.message);
    console.error("Error stack:", e.stack);
    
    // Provide helpful error messages for common issues
    if (e.message && e.message.includes('MongoServerSelectionError')) {
      console.error("\n💡 TROUBLESHOOTING:");
      console.error("   - Check if MongoDB server is running");
      console.error("   - Verify MONGODB_URI is correct in .env file");
      console.error("   - Check network connectivity to MongoDB host");
      console.error("   - Verify firewall rules allow connection");
    } else if (e.message && e.message.includes('authentication failed')) {
      console.error("\n💡 TROUBLESHOOTING:");
      console.error("   - Check MongoDB username and password in MONGODB_URI");
      console.error("   - Verify database user has proper permissions");
    } else if (e.message && e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED')) {
      console.error("\n💡 TROUBLESHOOTING:");
      console.error("   - MongoDB host is unreachable");
      console.error("   - Check MONGODB_URI hostname and port");
      console.error("   - Verify MongoDB service is running");
    }
    
    process.exit(1);
  }
};

startServer();