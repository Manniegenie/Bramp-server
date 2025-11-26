const mongoose = require('mongoose');

const baseRateAdditionSchema = new mongoose.Schema({
  addition: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  }
}, {
  timestamps: true,
  collection: 'baserateadditions'
});

module.exports = mongoose.model('BaseRateAddition', baseRateAdditionSchema);