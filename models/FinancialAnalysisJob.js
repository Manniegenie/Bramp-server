const mongoose = require('mongoose');

const financialAnalysisJobSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    jobId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    status: {
        type: String,
        enum: ['pending', 'extracting', 'extracted', 'analyzing', 'completed', 'failed'],
        default: 'pending',
        index: true
    },
    extractionStatus: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'pending'
    },
    analysisStatus: {
        type: String,
        enum: ['pending', 'processing', 'completed', 'failed'],
        default: 'pending'
    },
    bankStatement: {
        extractionId: String, // Extracta.ai extraction ID
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed'],
            default: 'pending'
        },
        fileName: String,
        fileSize: Number,
        fileBuffer: Buffer, // Store file buffer for async processing
        extractedData: mongoose.Schema.Types.Mixed, // Store extracted statement data
        processedAt: Date,
        error: String
    },
    cryptoStatement: {
        extractionId: String, // Extracta.ai extraction ID
        status: {
            type: String,
            enum: ['pending', 'processing', 'completed', 'failed'],
            default: 'pending'
        },
        fileName: String,
        fileSize: Number,
        fileBuffer: Buffer, // Store file buffer for async processing
        extractedData: mongoose.Schema.Types.Mixed, // Store extracted statement data
        processedAt: Date,
        error: String
    },
    report: {
        bank: mongoose.Schema.Types.Mixed,
        crypto: mongoose.Schema.Types.Mixed,
        combined: mongoose.Schema.Types.Mixed
    },
    emailSent: {
        type: Boolean,
        default: false
    },
    emailSentAt: Date,
    error: String,
    createdAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    completedAt: Date
});

// Update the updatedAt field before saving
financialAnalysisJobSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

// Method to check if extraction is complete
financialAnalysisJobSchema.methods.isExtractionComplete = function () {
    return this.extractionStatus === 'completed' ||
        (this.bankStatement.status === 'completed' && this.cryptoStatement.status === 'completed');
};

// Method to check if job is complete
financialAnalysisJobSchema.methods.isComplete = function () {
    return this.status === 'completed' && this.analysisStatus === 'completed';
};

// Method to check if job has failed
financialAnalysisJobSchema.methods.hasFailed = function () {
    return this.status === 'failed' ||
        this.extractionStatus === 'failed' ||
        this.analysisStatus === 'failed' ||
        this.bankStatement.status === 'failed' ||
        this.cryptoStatement.status === 'failed';
};

module.exports = mongoose.model('FinancialAnalysisJob', financialAnalysisJobSchema);

