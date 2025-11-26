const User = require('../models/user');
const logger = require('../utils/logger');
const { generateWalletBySchemaKey } = require('../utils/generatewallets');

// Reuse mapping style from routes/deposit.js
const WALLET_KEY_MAPPING = {
  'BTC_BTC': 'BTC_BTC',
  'BTC_BITCOIN': 'BTC_BTC',
  'ETH_ETH': 'ETH_ETH',
  'ETH_ETHEREUM': 'ETH_ETH',
  'SOL_SOL': 'SOL_SOL',
  'SOL_SOLANA': 'SOL_SOL',
  'USDT_ETH': 'USDT_ETH',
  'USDT_ETHEREUM': 'USDT_ETH',
  'USDT_ERC20': 'USDT_ETH',
  'USDT_TRX': 'USDT_TRX',
  'USDT_TRON': 'USDT_TRX',
  'USDT_TRC20': 'USDT_TRX',
  'USDT_BSC': 'USDT_BSC',
  'USDT_BEP20': 'USDT_BSC',
  'USDT_BINANCE': 'USDT_BSC',
  'USDC_ETH': 'USDC_ETH',
  'USDC_ETHEREUM': 'USDC_ETH',
  'USDC_ERC20': 'USDC_ETH',
  'USDC_BSC': 'USDC_BSC',
  'USDC_BEP20': 'USDC_BSC',
  'USDC_BINANCE': 'USDC_BSC',
  'BNB_ETH': 'BNB_ETH',
  'BNB_ETHEREUM': 'BNB_ETH',
  'BNB_ERC20': 'BNB_ETH',
  'BNB_BSC': 'BNB_BSC',
  'BNB_BEP20': 'BNB_BSC',
  'BNB_BINANCE': 'BNB_BSC',
  'MATIC_ETH': 'MATIC_ETH',
  'MATIC_ETHEREUM': 'MATIC_ETH',
  'MATIC_ERC20': 'MATIC_ETH',
  'MATIC_POLYGON': 'MATIC_ETH',
  'AVAX_BSC': 'AVAX_BSC',
  'AVAX_BEP20': 'AVAX_BSC',
  'AVAX_BINANCE': 'AVAX_BSC',
  'AVAX_AVALANCHE': 'AVAX_BSC',
  'NGNB_NGNB': 'NGNB',
  'NGNB': 'NGNB',
};

function getWalletKey(tokenSymbol, network) {
  const key1 = `${String(tokenSymbol).toUpperCase()}_${String(network).toUpperCase()}`;
  const key2 = String(tokenSymbol).toUpperCase();
  return WALLET_KEY_MAPPING[key1] || WALLET_KEY_MAPPING[key2] || null;
}

async function getSellDepositAddress(userId, tokenSymbol, network) {
  const user = await User.findById(userId).select('wallets email');
  if (!user) throw new Error('User not found');

  const walletKey = getWalletKey(tokenSymbol, network);
  if (!walletKey) throw new Error(`Invalid token/network: ${tokenSymbol}/${network}`);

  let wallet = user.wallets?.[walletKey];
  if (!wallet || !wallet.address) {
    logger.info('Generating per-intent sell wallet (on-demand)', { userId, tokenSymbol, network, walletKey });
    const walletData = await generateWalletBySchemaKey(user.email, userId, walletKey);
    await User.findByIdAndUpdate(userId, { [`wallets.${walletKey}`]: walletData });
    wallet = walletData;
  }

  return { walletKey, address: wallet.address, memo: wallet.memo || null, network: wallet.network || network };
}

module.exports = { getSellDepositAddress };


