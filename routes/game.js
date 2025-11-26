const express = require('express');
const router = express.Router();

const Game = require('../models/game');
const User = require('../models/user');
const logger = require('../utils/logger');

const NGNB_INCREMENT = 0.5; // per score point

async function updateLeaderboard() {
    // Compute top 10 users by score
    const top = await Game.find({ type: 'progress' })
        .sort({ score: -1, updatedAt: 1 })
        .limit(10)
        .lean();

    // Build label strings
    const userIds = top.map(t => t.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }).select('username email').lean();
    const uMap = new Map(users.map(u => [String(u._id), u]));

    const labels = top.map((t, idx) => {
        const u = t.userId ? uMap.get(String(t.userId)) : null;
        const name = u?.username || u?.email || String(t.userId || 'unknown');
        return `${idx + 1}. ${name} — ${t.score}`;
    });

    const meta = await Game.getOrCreateLeaderboard();
    meta.leaderboard = labels.slice(0, 10);
    await meta.save();
    return meta.leaderboard;
}

// Increment score endpoint
router.post('/score', express.json(), async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        // 1) Increase user's NGNB balance by 0.5
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        user.ngnbBalance = (Number(user.ngnbBalance) || 0) + NGNB_INCREMENT;
        await user.save();

        // 2) Upsert per-user game progress: +1 score, update balance snapshot
        const progress = await Game.findOneAndUpdate(
            { type: 'progress', userId },
            { $inc: { score: 1 }, $set: { balance: user.ngnbBalance } },
            { new: true, upsert: true }
        );

        // 3) Update leaderboard
        const leaderboard = await updateLeaderboard();

        return res.status(200).json({
            success: true,
            score: progress.score,
            balance: progress.balance,
            leaderboard
        });
    } catch (err) {
        logger.error?.('Game score update failed', { error: err?.message || err });
        return res.status(500).json({ success: false, message: 'Internal error' });
    }
});

module.exports = router;

// Fetch leaderboard (top 10 strings)
router.get('/leaderboard', async (_req, res) => {
    try {
        const meta = await Game.getOrCreateLeaderboard();
        return res.status(200).json({ success: true, leaderboard: meta.leaderboard || [] });
    } catch (err) {
        logger.error?.('Fetch leaderboard failed', { error: err?.message || err });
        return res.status(500).json({ success: false, message: 'Internal error' });
    }
});
