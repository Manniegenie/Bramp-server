const mongoose = require('mongoose');

const nairaMarkupSchema = new mongoose.Schema({
  markup: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('NairaMark', nairaMarkupSchema);
