# Lisk Wallet Integration Guide

## Backend Implementation Complete ✅

The backend is now set up with Lisk wallet connection functionality.

## API Endpoints

### 1. Initiate Wallet Connection
**POST** `/lisk/connect`
- **Auth**: Required (Bearer token)
- **Body**: 
  ```json
  {
    "network": "mainnet" // or "testnet"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Connect your Lisk wallet to Bramp\n\nUser ID: ...\nTimestamp: ...",
    "timestamp": "2025-11-22T...",
    "network": "mainnet",
    "instructions": "Please sign this message with your Lisk wallet..."
  }
  ```

### 2. Verify Wallet Connection
**POST** `/lisk/verify`
- **Auth**: Required (Bearer token)
- **Body**:
  ```json
  {
    "address": "lsk...",
    "signature": "...",
    "message": "Connect your Lisk wallet to Bramp...",
    "network": "mainnet"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Lisk wallet connected successfully",
    "wallet": {
      "address": "lsk...",
      "network": "mainnet",
      "balance": "1000000000",
      "publicKey": "..."
    }
  }
  ```

### 3. Get Connected Wallet
**GET** `/lisk/account`
- **Auth**: Required (Bearer token)
- **Response**:
  ```json
  {
    "success": true,
    "wallet": {
      "address": "lsk...",
      "network": "mainnet",
      "balance": "1000000000",
      "publicKey": "...",
      "connectedAt": "2025-11-22T...",
      "verified": true
    }
  }
  ```

### 4. Disconnect Wallet
**POST** `/lisk/disconnect`
- **Auth**: Required (Bearer token)

## Frontend Integration Example

### Using Lisk SDK (Recommended)

```javascript
// Install: npm install @liskhq/lisk-client

import { apiClient } from '@liskhq/lisk-client';

// Initialize Lisk client
const client = await apiClient.createWSClient('wss://rpc.api.lisk.com');

// Connect Wallet Function
async function connectLiskWallet() {
  try {
    // 1. Request connection from backend
    const response = await fetch('https://priscaai.online/lisk/connect', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ network: 'mainnet' })
    });
    
    const { message, timestamp } = await response.json();
    
    // 2. Request user to sign message with their Lisk wallet
    // This would typically use a wallet extension or mobile app
    // For web, you might use MetaMask with Lisk network added
    
    // 3. Get signature from wallet
    const signature = await requestWalletSignature(message);
    const address = await getWalletAddress();
    
    // 4. Verify connection
    const verifyResponse = await fetch('https://priscaai.online/lisk/verify', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        address: address,
        signature: signature,
        message: message,
        network: 'mainnet'
      })
    });
    
    const result = await verifyResponse.json();
    
    if (result.success) {
      console.log('Wallet connected!', result.wallet);
      return result;
    }
  } catch (error) {
    console.error('Failed to connect wallet:', error);
  }
}
```

### Using MetaMask (Alternative)

Since Lisk is EVM-compatible, users can connect via MetaMask:

```javascript
// Add Lisk network to MetaMask first
async function addLiskNetwork() {
  try {
    await window.ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: '0x46F', // 1135 in hex
        chainName: 'Lisk',
        nativeCurrency: {
          name: 'LSK',
          symbol: 'LSK',
          decimals: 18
        },
        rpcUrls: ['https://rpc.api.lisk.com'],
        blockExplorerUrls: ['https://blockscout.lisk.com']
      }]
    });
  } catch (error) {
    console.error('Failed to add Lisk network:', error);
  }
}

// Connect wallet
async function connectWallet() {
  try {
    // Request account access
    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts'
    });
    
    const address = accounts[0];
    
    // Get connection message from backend
    const response = await fetch('https://priscaai.online/lisk/connect', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ network: 'mainnet' })
    });
    
    const { message } = await response.json();
    
    // Sign message
    const signature = await window.ethereum.request({
      method: 'personal_sign',
      params: [message, address]
    });
    
    // Verify
    const verifyResponse = await fetch('https://priscaai.online/lisk/verify', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        address: address,
        signature: signature,
        message: message,
        network: 'mainnet'
      })
    });
    
    return await verifyResponse.json();
  } catch (error) {
    console.error('Connection failed:', error);
  }
}
```

## Chatbot Integration

The chatbot now supports Lisk wallet connection through these functions:

1. **`connect_lisk_wallet`** - Initiates wallet connection
2. **`verify_lisk_wallet`** - Verifies wallet with signature
3. **`get_lisk_wallet`** - Gets connected wallet info

Users can say:
- "Connect my Lisk wallet"
- "Link my Lisk wallet"
- "Show my Lisk wallet"
- "What's my Lisk balance?"

## Environment Variables

Add to `.env`:
```
LISK_RPC_URL=https://rpc.api.lisk.com
LISK_TESTNET_RPC_URL=https://rpc.testnet.lisk.com
```

## Next Steps

1. Install Lisk SDK on frontend: `npm install @liskhq/lisk-client`
2. Add "Connect Wallet" button to your UI
3. Implement wallet signature request (using Lisk wallet app or MetaMask)
4. Test the connection flow

