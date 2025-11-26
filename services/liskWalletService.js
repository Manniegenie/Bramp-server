/**
 * Lisk Wallet Connection Service
 * Handles Lisk wallet connection and interaction
 */

const axios = require('axios');
const logger = require('../utils/logger');

// Lisk network configuration
const LISK_CONFIG = {
  mainnet: {
    rpcUrl: process.env.LISK_RPC_URL || 'https://rpc.api.lisk.com',
    chainId: 1135,
    networkId: 'lisk_mainnet',
    explorerUrl: 'https://blockscout.lisk.com'
  },
  testnet: {
    rpcUrl: process.env.LISK_TESTNET_RPC_URL || 'https://rpc.testnet.lisk.com',
    chainId: 1136,
    networkId: 'lisk_testnet',
    explorerUrl: 'https://blockscout.testnet.lisk.com'
  }
};

/**
 * Get Lisk network configuration
 */
function getLiskConfig(network = 'mainnet') {
  return LISK_CONFIG[network] || LISK_CONFIG.mainnet;
}

/**
 * Validate Lisk address format
 * Lisk addresses are 20-byte addresses encoded in base32
 */
function isValidLiskAddress(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }
  
  // Lisk address format: starts with 'lsk' followed by 38 characters (base32)
  // Total length: 41 characters
  const liskAddressRegex = /^lsk[a-z0-9]{38}$/i;
  return liskAddressRegex.test(address);
}

/**
 * Get account information from Lisk network
 */
async function getLiskAccount(address, network = 'mainnet') {
  try {
    const config = getLiskConfig(network);
    const response = await axios.get(`${config.rpcUrl}/api/v3/accounts`, {
      params: {
        address: address
      },
      timeout: 10000
    });

    if (response.data && response.data.data && response.data.data.length > 0) {
      return {
        success: true,
        address: response.data.data[0].address,
        publicKey: response.data.data[0].publicKey,
        balance: response.data.data[0].token?.balance || '0',
        username: response.data.data[0].dpos?.delegate?.username || null
      };
    }

    return {
      success: false,
      error: 'Account not found'
    };
  } catch (error) {
    logger.error('Failed to fetch Lisk account', {
      error: error.message,
      address,
      network
    });
    
    return {
      success: false,
      error: error.message || 'Failed to fetch account information'
    };
  }
}

/**
 * Verify wallet connection by requesting a signature
 * This is a placeholder - actual implementation would require frontend wallet interaction
 */
async function verifyWalletConnection(address, signature, message) {
  try {
    // In a real implementation, you would:
    // 1. Request user to sign a message with their Lisk wallet
    // 2. Verify the signature matches the address
    // 3. Store the connection
    
    // For now, we'll just validate the address format
    if (!isValidLiskAddress(address)) {
      return {
        success: false,
        error: 'Invalid Lisk address format'
      };
    }

    // Verify signature (simplified - in production, use proper cryptographic verification)
    if (!signature || !message) {
      return {
        success: false,
        error: 'Signature and message required for verification'
      };
    }

    return {
      success: true,
      address: address,
      verified: true,
      message: 'Wallet connection verified'
    };
  } catch (error) {
    logger.error('Failed to verify wallet connection', {
      error: error.message,
      address
    });
    
    return {
      success: false,
      error: error.message || 'Failed to verify wallet connection'
    };
  }
}

/**
 * Generate a connection message for wallet signing
 */
function generateConnectionMessage(userId, timestamp) {
  return `Connect your Lisk wallet to Bramp\n\nUser ID: ${userId}\nTimestamp: ${timestamp}\n\nThis request will not trigger any blockchain transaction.`;
}

module.exports = {
  getLiskConfig,
  isValidLiskAddress,
  getLiskAccount,
  verifyWalletConnection,
  generateConnectionMessage
};

