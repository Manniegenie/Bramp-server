const mongoose = require('mongoose');

const KYCSchema = new mongoose.Schema({
  // User association
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },

  // Provider information
  provider: { 
    type: String, 
    required: true, 
    enum: ['smile-id', 'manual', 'other'],
    default: 'smile-id'
  },
  environment: { 
    type: String, 
    enum: ['production', 'sandbox', 'test', 'unknown'],
    default: 'unknown'
  },

  // Job identification
  partnerJobId: { type: String, index: true },
  jobType: { 
    type: String,
    enum: ['biometric_kyc', 'enhanced_kyc', 'document_verification', 'id_verification', 'other']
  },
  smileJobId: { 
    type: String, 
    unique: true, 
    sparse: true
  },

  // Job status
  jobComplete: { type: Boolean },
  jobSuccess: { type: Boolean },
  status: { 
    type: String, 
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'PROVISIONAL', 'EXPIRED'],
    required: true,
    index: true
  },

  // Result details
  resultCode: { type: String },
  resultText: { type: String },
  actions: { type: mongoose.Schema.Types.Mixed },

  // Personal information extracted
  country: { type: String, uppercase: true },
  idType: { 
    type: String,
    enum: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE', 'VOTER_ID', 'BVN', 'OTHER']
  },
  idNumber: { type: String },
  fullName: { type: String },
  dob: { type: Date },
  gender: { type: String, enum: ['M', 'F', 'OTHER'] },
  
  // Document validity
  expiresAt: { type: Date },

  // Media and verification artifacts
  imageLinks: { type: mongoose.Schema.Types.Mixed },
  history: { type: mongoose.Schema.Types.Mixed },

  // Security and audit
  signature: { type: String },
  signatureValid: { type: Boolean, default: false },
  providerTimestamp: { type: Date },

  // Raw data storage
  payload: { type: mongoose.Schema.Types.Mixed },

  // Error handling
  errorReason: { type: String },
  provisionalReason: { type: String },

  // Internal tracking
  attempts: { type: Number, default: 1 },
  lastAttemptAt: { type: Date, default: Date.now },
  
  // Admin fields
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  reviewNotes: { type: String },
  
  // Compliance flags
  isActive: { type: Boolean, default: true },
  expiryNotificationSent: { type: Boolean, default: false },
  
  // Additional verification scores (if provided by SmileID)
  confidenceScore: { type: Number, min: 0, max: 100 },
  riskScore: { type: Number, min: 0, max: 100 },
  
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
KYCSchema.index({ userId: 1, status: 1 });
KYCSchema.index({ userId: 1, createdAt: -1 });
KYCSchema.index({ smileJobId: 1 }, { unique: true, sparse: true });
KYCSchema.index({ partnerJobId: 1, userId: 1 }, { unique: true, sparse: true });
KYCSchema.index({ status: 1, createdAt: -1 });
KYCSchema.index({ provider: 1, environment: 1 });
KYCSchema.index({ expiresAt: 1 }, { sparse: true });

// Virtual for checking if document is expired
KYCSchema.virtual('isDocumentExpired').get(function() {
  return this.expiresAt && this.expiresAt < new Date();
});

// Virtual for checking if KYC is valid
KYCSchema.virtual('isValid').get(function() {
  return this.status === 'APPROVED' && 
         this.isActive && 
         (!this.expiresAt || this.expiresAt > new Date());
});

// Virtual for age calculation
KYCSchema.virtual('age').get(function() {
  if (!this.dob) return null;
  const today = new Date();
  const birth = new Date(this.dob);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
});

// Pre-save middleware
KYCSchema.pre('save', function(next) {
  // Update attempt tracking
  if (this.isModified('status') && !this.isNew) {
    this.attempts += 1;
    this.lastAttemptAt = new Date();
  }
  
  // Auto-set review timestamp if status changed to APPROVED/REJECTED
  if (this.isModified('status') && 
      (this.status === 'APPROVED' || this.status === 'REJECTED') && 
      !this.reviewedAt) {
    this.reviewedAt = new Date();
  }
  
  next();
});

// Instance methods
KYCSchema.methods.approve = function(reviewerId, notes) {
  this.status = 'APPROVED';
  this.reviewedBy = reviewerId;
  this.reviewedAt = new Date();
  if (notes) this.reviewNotes = notes;
  return this.save();
};

KYCSchema.methods.reject = function(reviewerId, reason, notes) {
  this.status = 'REJECTED';
  this.errorReason = reason;
  this.reviewedBy = reviewerId;
  this.reviewedAt = new Date();
  if (notes) this.reviewNotes = notes;
  return this.save();
};

KYCSchema.methods.markProvisional = function(reason) {
  this.status = 'PROVISIONAL';
  this.provisionalReason = reason;
  return this.save();
};

KYCSchema.methods.deactivate = function() {
  this.isActive = false;
  return this.save();
};

// Static methods
KYCSchema.statics.findActiveByUserId = function(userId) {
  return this.findOne({ 
    userId, 
    isActive: true, 
    status: 'APPROVED',
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ]
  }).sort({ createdAt: -1 });
};

KYCSchema.statics.findLatestByUserId = function(userId) {
  return this.findOne({ userId })
    .sort({ createdAt: -1 });
};

KYCSchema.statics.getKYCStats = function() {
  return this.aggregate([
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgConfidenceScore: { $avg: '$confidenceScore' }
      }
    }
  ]);
};

KYCSchema.statics.findExpiringDocuments = function(daysFromNow = 30) {
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysFromNow);
  
  return this.find({
    status: 'APPROVED',
    isActive: true,
    expiresAt: { 
      $exists: true, 
      $lte: futureDate,
      $gt: new Date()
    },
    expiryNotificationSent: false
  });
};

// Query helpers
KYCSchema.query.byStatus = function(status) {
  return this.where({ status });
};

KYCSchema.query.active = function() {
  return this.where({ isActive: true });
};

KYCSchema.query.byProvider = function(provider) {
  return this.where({ provider });
};

KYCSchema.query.approved = function() {
  return this.where({ 
    status: 'APPROVED',
    isActive: true,
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ]
  });
};

module.exports = mongoose.model('KYC', KYCSchema);