require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const User = require('../models/user');
const Game = require('../models/game');

// Optional OpenAI SDK (reuse pattern from scan.js)
const OpenAI = (() => { try { return require('openai'); } catch (e) { return null; } })();
let logger; try { logger = require('../utils/logger'); } catch { logger = console; }

let openai = null;
try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (OpenAI && OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
        openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        logger.info('Voice route: OpenAI initialized');
    } else {
        logger.warn('Voice route: OpenAI not available; falling back to text-only.');
    }
} catch (e) {
    logger.error('Voice route: OpenAI init error:', e?.message || e);
}

// In-memory cache for active sessions (fast lookups during /respond)
// activeSessions[userId] = { startedAt, expiresAt }
const activeSessions = new Map();

const ONE_MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const VOICE_SESSION_DURATION = 5 * 60 * 1000; // 5 minutes for voice sessions

// Update voice leaderboard (similar to game leaderboard)
async function updateVoiceLeaderboard() {
    // Compute top 10 users by voice score
    const top = await Game.find({ type: 'voice-progress' })
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

    const meta = await Game.getOrCreateVoiceLeaderboard();
    meta.leaderboard = labels.slice(0, 10);
    await meta.save();
    return meta.leaderboard;
}

// Cleanup expired sessions from memory cache and database periodically
setInterval(async () => {
    const now = Date.now();
    const expiredUsers = [];

    // Clean up in-memory cache
    for (const [userId, session] of activeSessions.entries()) {
        if (session.expiresAt <= now) {
            activeSessions.delete(userId);
            expiredUsers.push(userId);
        }
    }

    // Clean up database sessions that are expired
    try {
        const cutoffDate = new Date(now);
        const result = await User.updateMany(
            { 'voiceSession.expiresAt': { $lt: cutoffDate } },
            { $set: { 'voiceSession': { startedAt: null, expiresAt: null } } }
        );

        if (result.modifiedCount > 0 || expiredUsers.length > 0) {
            logger.info(`Voice cleanup: Removed ${expiredUsers.length} from cache, ${result.modifiedCount} from database`);
        }
    } catch (cleanupErr) {
        logger.error('Voice cleanup: Database cleanup failed', cleanupErr?.message || cleanupErr);
    }
}, 30000); // Clean every 30 seconds

// Start a voice session (no cooldown)
router.post('/start', async (req, res) => {
    try {
        const userId = String(req.user?.id || '');
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const now = Date.now();
        const startedAt = new Date(now);
        const expiresAt = new Date(now + VOICE_SESSION_DURATION);

        // Clean up any existing expired session first
        if (user.voiceSession?.expiresAt) {
            const existingExpiresAt = new Date(user.voiceSession.expiresAt).getTime();
            if (existingExpiresAt <= now) {
                logger.info(`Voice start: Cleaning up expired session for user ${userId}`);
                user.voiceSession = { startedAt: null, expiresAt: null };
            }
        }

        // Save new session (no cooldown enforcement)
        user.voiceSession = { startedAt, expiresAt };
        await user.save();

        // Update in-memory cache
        activeSessions.set(userId, {
            startedAt: startedAt.getTime(),
            expiresAt: expiresAt.getTime()
        });

        logger.info(`Voice start: Session started for user ${userId}`, {
            expiresAt: expiresAt.toISOString(),
            durationMs: VOICE_SESSION_DURATION
        });

        return res.json({
            success: true,
            startedAt: startedAt.getTime(),
            expiresAt: expiresAt.getTime(),
            maxDurationMs: VOICE_SESSION_DURATION
        });
    } catch (err) {
        logger.error('Voice start error:', err?.message || err);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// End a voice session (no cooldown)
router.post('/end', async (req, res) => {
    try {
        const userId = String(req.user?.id || '');
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        // Remove from in-memory cache first
        const hadActiveSession = activeSessions.has(userId);
        activeSessions.delete(userId);

        // Update user document: clear session
        try {
            const user = await User.findById(userId);
            if (user) {
                // Only update if there was actually a session to clear
                if (user.voiceSession?.startedAt || user.voiceSession?.expiresAt) {
                    user.voiceSession = { startedAt: null, expiresAt: null };
                    await user.save();
                    logger.info(`Voice end: Session cleared for user ${userId}`);
                } else if (hadActiveSession) {
                    // Had in-memory session but DB was stale - still clear it
                    user.voiceSession = { startedAt: null, expiresAt: null };
                    await user.save();
                    logger.info(`Voice end: Stale session cleared for user ${userId}`);
                }
            }
        } catch (dbErr) {
            logger.error('Voice end: Database cleanup failed', dbErr?.message || dbErr);
            // Still return success since in-memory cache is cleared
        }

        return res.json({ success: true });
    } catch (err) {
        logger.error('Voice end error:', err?.message || err);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Transcribe audio using OpenAI Whisper: takes audio blob and returns { transcript }
router.post('/transcribe', async (req, res) => {
    try {
        const userId = String(req.user?.id || '');
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        // Fast check in-memory cache first
        let session = activeSessions.get(userId);
        const now = Date.now();

        // Validate session (with cleanup if expired)
        if (!session || session.expiresAt <= now) {
            const user = await User.findById(userId);
            if (!user || !user.voiceSession?.expiresAt) {
                // Ensure cache is clean
                activeSessions.delete(userId);
                return res.status(410).json({ success: false, message: 'Voice session not found. Please restart voice chat.' });
            }

            const dbExpiresAt = new Date(user.voiceSession.expiresAt).getTime();
            if (dbExpiresAt <= now) {
                // Session expired in database - clean it up
                activeSessions.delete(userId);
                try {
                    user.voiceSession = { startedAt: null, expiresAt: null };
                    await user.save();
                } catch (cleanupErr) {
                    logger.warn('Voice transcribe: Failed to clean expired session', cleanupErr?.message);
                }
                return res.status(410).json({ success: false, message: 'Voice session expired. Please restart voice chat.' });
            }

            // Refresh cache from database
            session = {
                startedAt: new Date(user.voiceSession.startedAt).getTime(),
                expiresAt: dbExpiresAt
            };
            activeSessions.set(userId, session);
        }

        // Final validation check
        if (session.expiresAt <= now) {
            activeSessions.delete(userId);
            // Also clean database
            try {
                const user = await User.findById(userId);
                if (user && user.voiceSession?.expiresAt) {
                    user.voiceSession = { startedAt: null, expiresAt: null };
                    await user.save();
                }
            } catch (cleanupErr) {
                logger.warn('Voice transcribe: Failed to clean expired session', cleanupErr?.message);
            }
            return res.status(410).json({ success: false, message: 'Voice session expired. Please restart voice chat.' });
        }

        // Get audio file from request (multipart/form-data or base64)
        let audioBuffer = null;
        let audioMimeType = req.body.audioMimeType || 'audio/webm'; // Default to webm
        let audioExtension = 'webm';

        if (req.file) {
            // If using multer middleware
            audioBuffer = req.file.buffer;
            audioMimeType = req.file.mimetype || audioMimeType;
            // Determine extension from mime type
            if (audioMimeType.includes('webm')) audioExtension = 'webm';
            else if (audioMimeType.includes('mp4')) audioExtension = 'mp4';
            else if (audioMimeType.includes('ogg')) audioExtension = 'ogg';
            else if (audioMimeType.includes('wav')) audioExtension = 'wav';
        } else if (req.body.audioBase64) {
            // If audio is sent as base64
            audioBuffer = Buffer.from(req.body.audioBase64, 'base64');
            // Try to detect format from mimeType if provided
            if (req.body.audioMimeType) {
                audioMimeType = req.body.audioMimeType;
                if (audioMimeType.includes('webm')) audioExtension = 'webm';
                else if (audioMimeType.includes('mp4')) audioExtension = 'mp4';
                else if (audioMimeType.includes('ogg')) audioExtension = 'ogg';
                else if (audioMimeType.includes('wav')) audioExtension = 'wav';
            }
        } else if (req.body.audioBlob) {
            // If audio is sent as blob data
            audioBuffer = Buffer.from(req.body.audioBlob, 'base64');
        } else {
            return res.status(400).json({ success: false, message: 'No audio data provided' });
        }

        if (!openai) {
            return res.status(503).json({ success: false, message: 'OpenAI not available' });
        }

        // Use OpenAI Whisper to transcribe (industry standard approach)
        let transcript = '';
        try {
            logger.info('Voice transcribe: Sending audio to Whisper', {
                audioSize: audioBuffer.length,
                mimeType: audioMimeType,
                extension: audioExtension
            });

            // Industry standard: Use File object if available, otherwise use FormData with buffer
            let transcriptionResponse;

            // Check if File is available (Node.js 18+)
            if (typeof File !== 'undefined') {
                try {
                    // Create File object directly - OpenAI SDK preferred method
                    const audioFile = new File([audioBuffer], `audio.${audioExtension}`, { type: audioMimeType });

                    transcriptionResponse = await openai.audio.transcriptions.create({
                        file: audioFile,
                        model: 'whisper-1',
                        language: 'en',
                        response_format: 'json',
                    });

                    logger.info('Voice transcribe: Used File object method');
                } catch (fileError) {
                    logger.warn('Voice transcribe: File object method failed, trying FormData', fileError?.message);
                    throw fileError; // Will fall through to FormData method
                }
            } else {
                // Fallback: Use FormData with buffer (not stream to avoid null stream issues)
                const FormData = require('form-data');

                const formData = new FormData();
                // Append buffer directly, not as stream
                formData.append('file', audioBuffer, {
                    filename: `audio.${audioExtension}`,
                    contentType: audioMimeType,
                });
                formData.append('model', 'whisper-1');
                formData.append('language', 'en');
                formData.append('response_format', 'json');

                transcriptionResponse = await openai.audio.transcriptions.create(formData, {
                    headers: formData.getHeaders(),
                });

                logger.info('Voice transcribe: Used FormData method');
            }

            transcript = String(transcriptionResponse.text || '').trim();

            logger.info('Voice transcribe: Whisper transcription successful', {
                transcript,
                length: transcript.length,
                wordCount: transcript.split(/\s+/).length
            });
        } catch (e) {
            logger.error('Voice transcribe: Whisper failed', {
                message: e?.message,
                error: e?.error,
                code: e?.code,
                status: e?.status,
                stack: e?.stack?.split('\n').slice(0, 3).join('\n')
            });
            return res.status(500).json({
                success: false,
                message: 'Transcription failed',
                error: e?.message || 'Unknown error'
            });
        }

        if (!transcript) {
            return res.status(400).json({ success: false, message: 'No transcript received' });
        }

        return res.json({ success: true, transcript, expiresAt: session.expiresAt });
    } catch (err) {
        logger.error('Voice transcribe error:', err?.message || err);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Respond in a voice session: takes { message } and returns { reply, audioBase64 }
router.post('/respond', async (req, res) => {
    try {
        const userId = String(req.user?.id || '');
        if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

        // Fast check in-memory cache first
        let session = activeSessions.get(userId);
        const now = Date.now();

        // Validate session (with cleanup if expired)
        if (!session || session.expiresAt <= now) {
            const user = await User.findById(userId);
            if (!user || !user.voiceSession?.expiresAt) {
                // Ensure cache is clean
                activeSessions.delete(userId);
                return res.status(410).json({ success: false, message: 'Voice session not found. Please restart voice chat.' });
            }

            const dbExpiresAt = new Date(user.voiceSession.expiresAt).getTime();
            if (dbExpiresAt <= now) {
                // Session expired in database - clean it up
                activeSessions.delete(userId);
                try {
                    user.voiceSession = { startedAt: null, expiresAt: null };
                    await user.save();
                } catch (cleanupErr) {
                    logger.warn('Voice respond: Failed to clean expired session', cleanupErr?.message);
                }
                return res.status(410).json({ success: false, message: 'Voice session expired. Please restart voice chat.' });
            }

            // Refresh cache from database
            session = {
                startedAt: new Date(user.voiceSession.startedAt).getTime(),
                expiresAt: dbExpiresAt
            };
            activeSessions.set(userId, session);
        }

        // Final validation check
        if (session.expiresAt <= now) {
            activeSessions.delete(userId);
            // Also clean database
            try {
                const user = await User.findById(userId);
                if (user && user.voiceSession?.expiresAt) {
                    user.voiceSession = { startedAt: null, expiresAt: null };
                    await user.save();
                }
            } catch (cleanupErr) {
                logger.warn('Voice respond: Failed to clean expired session', cleanupErr?.message);
            }
            return res.status(410).json({ success: false, message: 'Voice session expired. Please restart voice chat.' });
        }

        const { message } = req.body || {};
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ success: false, message: 'Provide message (string)' });
        }

        // Call existing chatbot route to get a text reply using current intent system
        const base = (process.env.INTERNAL_API_BASE || process.env.API_BASE || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');
        let replyText = '';
        let detectedIntent = null;
        try {
            const chatResp = await axios.post(`${base}/chatbot/chat`, { message }, {
                headers: { Authorization: req.headers['authorization'] || '' },
                timeout: 20000,
            });
            replyText = String(chatResp.data?.reply || '');
            detectedIntent = chatResp.data?.metadata?.intent || null;

            // Check if sell/trade/payment intent was detected
            if (detectedIntent === 'sell') {
                logger.info('Voice respond: Sell intent detected, should trigger sell modal');
                // The frontend will handle opening the modal based on the CTA or response
                // We can include a flag in the response to help frontend detect this
            }

            // Summarize replyText to 50-100 words for voice (must be summarized, not cut off)
            if (openai && replyText && replyText.trim().length > 0) {
                const wordCount = replyText.split(/\s+/).length;
                if (wordCount > 100) {
                    logger.info('Voice respond: Summarizing response', { originalWords: wordCount });
                    try {
                        const summaryResp = await openai.chat.completions.create({
                            model: process.env.OPENAI_MODEL_PRIMARY || 'gpt-5',
                            messages: [
                                {
                                    role: 'system',
                                    content: 'You are a helpful assistant. Summarize the following text to 50-100 words. The summary must be complete and meaningful, not cut off mid-sentence. Preserve the key information and maintain a natural flow.'
                                },
                                {
                                    role: 'user',
                                    content: `Summarize this to 50-100 words:\n\n${replyText}`
                                }
                            ],
                            max_tokens: 200,
                            temperature: 0.7,
                        });

                        const summarizedText = summaryResp.choices?.[0]?.message?.content || replyText;
                        const summarizedWordCount = summarizedText.split(/\s+/).length;

                        if (summarizedWordCount <= 100 && summarizedWordCount >= 30) {
                            replyText = summarizedText.trim();
                            logger.info('Voice respond: Response summarized', {
                                originalWords: wordCount,
                                summarizedWords: summarizedWordCount
                            });
                        } else {
                            logger.warn('Voice respond: Summary out of range, using original', {
                                summarizedWords: summarizedWordCount
                            });
                            // If summary is still too long or too short, keep original but truncate intelligently
                            // Try one more time with stricter instructions
                            try {
                                const strictSummaryResp = await openai.chat.completions.create({
                                    model: process.env.OPENAI_MODEL_PRIMARY || 'gpt-5',
                                    messages: [
                                        {
                                            role: 'system',
                                            content: 'You are a helpful assistant. Summarize the following text to exactly 50-100 words. Be concise but complete. Never cut off mid-sentence.'
                                        },
                                        {
                                            role: 'user',
                                            content: `Summarize this to exactly 50-100 words:\n\n${replyText}`
                                        }
                                    ],
                                    max_tokens: 150,
                                    temperature: 0.5,
                                });
                                const strictSummarized = strictSummaryResp.choices?.[0]?.message?.content?.trim() || replyText;
                                const strictWordCount = strictSummarized.split(/\s+/).length;
                                if (strictWordCount <= 100) {
                                    replyText = strictSummarized;
                                    logger.info('Voice respond: Response re-summarized with strict limit', {
                                        words: strictWordCount
                                    });
                                }
                            } catch (retryErr) {
                                logger.warn('Voice respond: Re-summarization failed, using original', retryErr?.message);
                            }
                        }
                    } catch (summaryErr) {
                        logger.warn('Voice respond: Summarization failed, using original text', summaryErr?.message);
                        // Fall through to use original replyText
                    }
                } else {
                    logger.info('Voice respond: Response within word limit', { words: wordCount });
                }
            }
        } catch (e) {
            logger.warn('Voice respond: chatbot call failed', e?.message || e);
            replyText = 'Sorry, I could not process that right now.';
        }

        // Synthesize voice using OpenAI TTS if available
        let audioBase64 = null;
        if (openai && replyText) {
            try {
                const ttsModel = process.env.OPENAI_TTS_MODEL || 'tts-1';
                const voice = process.env.OPENAI_TTS_VOICE || 'alloy';
                const finalWordCount = replyText.split(/\s+/).length;
                logger.info('Voice respond: Generating TTS', {
                    replyLength: replyText.length,
                    wordCount: finalWordCount,
                    model: ttsModel,
                    voice
                });
                const speech = await openai.audio.speech.create({
                    model: ttsModel,
                    voice,
                    input: replyText,
                });
                const buffer = Buffer.from(await speech.arrayBuffer());
                audioBase64 = buffer.toString('base64');
                logger.info('Voice respond: TTS generated', {
                    audioSize: audioBase64.length,
                    audioSizeKB: Math.round(audioBase64.length / 1024),
                    wordCount: finalWordCount
                });
            } catch (e) {
                logger.warn('Voice respond: TTS failed', e?.message || e);
                audioBase64 = null;
            }
        } else {
            if (!openai) logger.warn('Voice respond: OpenAI TTS not available');
            if (!replyText) logger.warn('Voice respond: No reply text to synthesize');
        }

        // Track voice interaction and update leaderboard (similar to game scoring)
        let voiceScore = null;
        try {
            if (audioBase64 && audioBase64.length > 0) {
                // Increment voice score for successful voice interaction
                const progress = await Game.findOneAndUpdate(
                    { type: 'voice-progress', userId },
                    { $inc: { score: 1 } },
                    { new: true, upsert: true }
                );
                voiceScore = progress.score;

                // Update leaderboard (async, don't wait)
                updateVoiceLeaderboard().catch(err => {
                    logger.warn('Voice respond: Leaderboard update failed', err?.message);
                });
            }
        } catch (scoreErr) {
            logger.warn('Voice respond: Voice score update failed', scoreErr?.message);
        }

        // For voice chat, only return audio (no text to save tokens and avoid UI clutter)
        // Include intent flag for sell/trade/payment to trigger modal on frontend
        return res.json({
            success: true,
            reply: null,
            audioBase64,
            expiresAt: session.expiresAt,
            intent: detectedIntent === 'sell' ? 'sell' : null, // Signal frontend to open sell modal
            voiceScore: voiceScore // Return current voice score
        });
    } catch (err) {
        logger.error('Voice respond error:', err?.message || err);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Fetch voice leaderboard (top 10 strings)
router.get('/leaderboard', async (_req, res) => {
    try {
        const meta = await Game.getOrCreateVoiceLeaderboard();
        return res.status(200).json({ success: true, leaderboard: meta.leaderboard || [] });
    } catch (err) {
        logger.error?.('Fetch voice leaderboard failed', { error: err?.message || err });
        return res.status(500).json({ success: false, message: 'Internal error' });
    }
});

module.exports = router;


