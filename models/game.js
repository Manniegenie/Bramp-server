const mongoose = require('mongoose');

const gameSchema = new mongoose.Schema({
  type: { type: String, enum: ['progress', 'leaderboard', 'voice-progress', 'voice-leaderboard'], required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, default: null },
  score: { type: Number, default: 0, min: 0 },
  balance: { type: Number, default: 0, min: 0 },
  leaderboard: {
    type: [String],
    default: [],
    validate: {
      validator: function (arr) { return Array.isArray(arr) && arr.length <= 10; },
      message: 'Leaderboard must hold at most 10 entries'
    }
  }
}, { timestamps: true });

gameSchema.statics.getOrCreateLeaderboard = async function () {
  const Game = this;
  let doc = await Game.findOne({ type: 'leaderboard' });
  if (!doc) doc = await Game.create({ type: 'leaderboard', leaderboard: [] });
  return doc;
};

gameSchema.statics.getOrCreateVoiceLeaderboard = async function () {
  const Game = this;
  let doc = await Game.findOne({ type: 'voice-leaderboard' });
  if (!doc) doc = await Game.create({ type: 'voice-leaderboard', leaderboard: [] });
  return doc;
};

module.exports = mongoose.model('Game', gameSchema);
