// One-off seed: populate TokenNetwork from the list that used to be
// hardcoded in Chatbramp-app's services/depositService.js — the app now
// fetches this from GET /networks/all instead. Safe to re-run: upserts by
// (token, networkId), never deletes, so admin changes (enabled/order) made
// after the first run are preserved on later re-runs.
// Run once: node scripts/seed-token-networks.js
require('dotenv').config();
const mongoose = require('mongoose');
const TokenNetwork = require('../models/tokenNetwork');

const SEED = [
  { token: 'BTC', networkId: 'BTC', networkName: 'Bitcoin' },
  { token: 'ETH', networkId: 'ETH', networkName: 'Ethereum (ERC20)' },
  { token: 'SOL', networkId: 'SOL', networkName: 'Solana' },
  { token: 'USDT', networkId: 'ETH', networkName: 'Ethereum (ERC20)' },
  { token: 'USDT', networkId: 'TRX', networkName: 'Tron (TRC20)' },
  { token: 'USDT', networkId: 'BSC', networkName: 'BNB Smart Chain (BEP20)' },
  { token: 'USDC', networkId: 'ETH', networkName: 'Ethereum (ERC20)' },
  { token: 'USDC', networkId: 'BSC', networkName: 'BNB Smart Chain (BEP20)' },
  { token: 'USDC', networkId: 'ARBITRUM', networkName: 'Arbitrum One' },
  { token: 'BNB', networkId: 'BSC', networkName: 'BNB Smart Chain (BEP20)' },
  { token: 'BNB', networkId: 'ETH', networkName: 'Ethereum (ERC20)' },
  { token: 'MATIC', networkId: 'ETH', networkName: 'Ethereum (ERC20)' },
  { token: 'MATIC', networkId: 'POLYGON', networkName: 'Polygon' },
  { token: 'AVAX', networkId: 'BSC', networkName: 'BNB Smart Chain (BEP20)' },
  { token: 'NGNB', networkId: 'NGNB', networkName: 'Internal' },
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected. Seeding token networks...');

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < SEED.length; i++) {
    const entry = SEED[i];
    // order is per-token position in the list above, preserving the
    // original hardcoded display order
    const order = SEED.filter((e) => e.token === entry.token).indexOf(entry);
    const result = await TokenNetwork.findOneAndUpdate(
      { token: entry.token, networkId: entry.networkId },
      { $setOnInsert: { ...entry, order, enabled: true } },
      { upsert: true, new: false }
    );
    if (result === null) created++;
    else skipped++;
  }

  console.log(`Created: ${created}, already existed (skipped): ${skipped}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
