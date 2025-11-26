const mongoose = require('mongoose');

const obiexRateSchema = new mongoose.Schema({
  rate: {
    type: Number,
    required: true,
    min: 0
  },
  markup: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  baseRate: {
    type: Number,
    required: false,
    min: 0,
    default: null
  },
  lastAPIRate: {
    type: Number,
    required: false,
    min: 0,
    default: null
  },
  rateSource: {
    type: String,
    enum: ['manual', 'obiex_api', 'external_api'],
    default: 'manual'
  }
}, {
  timestamps: true,
  collection: 'obiexrates'
});

module.exports = mongoose.model('ObiexRate', obiexRateSchema);