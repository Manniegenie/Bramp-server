// Update to AVAILABLE_TOOLS: Remove deprecated 'match_naira' and 'get_bank_details' tools
const AVAILABLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_sell_transaction',
      description: 'Initiate a sell transaction to convert crypto to NGN. ONLY call this after user has provided bank details. The system will automatically validate the account details (including bank name matching and account name resolution) and save payout details upon success. This will return a deposit address for the user to send crypto to, and prompt the user to double-check the account name. REQUIRES: token, network, bankCode, accountNumber, bankName (optional if partial for matching). AccountName is fetched via validation. REQUIRES AUTHENTICATION.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to sell'
          },
          network: {
            type: 'string',
            enum: ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'ERC20', 'SOL', 'SOLANA', 'TRX', 'TRON', 'TRC20', 'BSC', 'BNB SMART CHAIN', 'BEP20', 'BINANCE', 'POLYGON', 'AVALANCHE'],
            description: 'The blockchain network for the token (must match token). Common values: BTC/BITCOIN for Bitcoin, ETH/ETHEREUM/ERC20 for Ethereum, SOL/SOLANA for Solana, TRX/TRON/TRC20 for Tron, BSC/BNB SMART CHAIN/BEP20 for BNB Smart Chain, POLYGON for Polygon, AVALANCHE for Avalanche'
          },
          amount: {
            type: 'number',
            description: 'Amount to sell in token units (optional - user can send any amount)'
          },
          currency: {
            type: 'string',
            enum: ['TOKEN', 'NGN'],
            description: 'Currency of the amount - TOKEN for crypto amount, NGN for NGN amount',
            default: 'TOKEN'
          },
          bankCode: {
            type: 'string',
            description: 'Bank code for payout (REQUIRED)'
          },
          accountNumber: {
            type: 'string',
            description: 'Bank account number for payout (REQUIRED)'
          },
          bankName: {
            type: 'string',
            description: 'Full or partial bank name for payout (optional - will be matched/validated if provided)'
          },
          accountName: {
            type: 'string',
            description: 'Account holder name (optional - will be resolved via validation)'
          }
        },
        required: ['token', 'network', 'bankCode', 'accountNumber']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'validate_account',
      description: 'Validate bank account details by matching a provided bank name (if partial) to the official code/name, then resolving the account name via bank API. Use this standalone when user wants to check/validate their bank details before a transaction, or let create_sell_transaction handle it automatically. Returns matched bank details, validated account name, and a confirmation prompt. REQUIRES AUTHENTICATION.',
      parameters: {
        type: 'object',
        properties: {
          bankCode: {
            type: 'string',
            description: 'Bank code (e.g., "044" for Access Bank) - REQUIRED if no providedName'
          },
          accountNumber: {
            type: 'string',
            description: 'Account number to validate - REQUIRED'
          },
          providedName: {
            type: 'string',
            description: 'Full or partial bank name to match (e.g., "GTB", "Access") - optional, but triggers matching if provided'
          }
        },
        required: ['accountNumber']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_sell_quote',
      description: 'Get a quote showing how much NGN user will receive for selling crypto. Use when user asks "how much will I get", "what is the rate", "how much naira for X tokens", or wants to know the quote before selling. REQUIRES AUTHENTICATION. REQUIRES: token and amount. Network will be auto-detected from token if not provided. Do NOT call this function if token or amount is missing - ask the user first. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to sell'
          },
          amount: {
            type: 'number',
            description: 'Amount to sell in token units'
          }
        },
        required: ['token', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_buy_transaction',
      description: 'Initiate a buy transaction (NGN to crypto). REQUIRES USER TO BE AUTHENTICATED/SIGNED IN. Do not call this function if user is not signed in. User pays NGN and receives crypto.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to buy'
          },
          network: {
            type: 'string',
            enum: ['BITCOIN NETWORK', 'ETHEREUM NETWORK', 'SOLANA NETWORK', 'TRON NETWORK', 'BNB SMART CHAIN', 'POLYGON NETWORK', 'AVALANCHE NETWORK'],
            description: 'The blockchain network for the token'
          },
          amount: {
            type: 'number',
            description: 'Amount to buy in NGN (minimum 5000 NGN)'
          }
        },
        required: ['token', 'network', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_buy_quote',
      description: 'Get a quote for buying crypto (how much crypto you will receive for NGN). REQUIRES USER TO BE AUTHENTICATED/SIGNED IN. Do not call this function if user is not signed in.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to buy'
          },
          amount: {
            type: 'number',
            description: 'Amount to spend in NGN'
          }
        },
        required: ['token', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_transaction_status',
      description: 'Check the status of a transaction by payment ID',
      parameters: {
        type: 'object',
        properties: {
          paymentId: {
            type: 'string',
            description: 'The payment ID or transaction reference'
          }
        },
        required: ['paymentId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_naira_rates',
      description: 'Get current NGN/USD exchange rates. Use this when user asks about naira rates, NGN rates, exchange rates, selling rates, buying rates, or "how much naira". Returns both offramp (selling) and onramp (buying) rates. No authentication required.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_token_price',
      description: 'Get current price of a cryptocurrency token in USD. Use this when user asks about token price, crypto price, "how much is BTC", "what is the price of ETH", or current value of any supported token (BTC, ETH, SOL, USDT, USDC, BNB, MATIC, AVAX). No authentication required.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token'
          }
        },
        required: ['token']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dashboard',
      description: 'Get user dashboard data including portfolio balance, holdings, and account info. Use when user asks about balance, portfolio, wallet, holdings, assets, or "show my account". REQUIRES AUTHENTICATION. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_transaction_history',
      description: 'Get transaction history for the user (recent transactions)',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of transactions to return',
            default: 10
          },
          dateFrom: {
            type: 'string',
            description: 'Start date in ISO format (optional)'
          },
          dateTo: {
            type: 'string',
            description: 'End date in ISO format (optional)'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'connect_lisk_wallet',
      description: 'Connect a Lisk wallet to the user\'s account. Use when user wants to connect, link, or add their Lisk wallet. REQUIRES AUTHENTICATION. This will generate a message that the user needs to sign with their Lisk wallet to verify ownership. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {
          network: {
            type: 'string',
            enum: ['mainnet', 'testnet'],
            description: 'Lisk network to connect to (mainnet or testnet)',
            default: 'mainnet'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verify_lisk_wallet',
      description: 'Verify Lisk wallet connection by providing the signed message. Use after user has signed the connection message with their Lisk wallet. REQUIRES AUTHENTICATION. Needs: address, signature, and the original message. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Lisk wallet address (starts with lsk)'
          },
          signature: {
            type: 'string',
            description: 'Signature of the connection message signed by the wallet'
          },
          message: {
            type: 'string',
            description: 'The original connection message that was signed'
          },
          network: {
            type: 'string',
            enum: ['mainnet', 'testnet'],
            description: 'Lisk network (mainnet or testnet)',
            default: 'mainnet'
          }
        },
        required: ['address', 'signature', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_lisk_wallet',
      description: 'Get connected Lisk wallet information including address and balance. Use when user asks about their Lisk wallet, Lisk balance, or connected wallet. REQUIRES AUTHENTICATION. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browse_web',
      description: 'Search the web for recent information that is not available in my training data. Use this when user asks about current events, recent news, latest prices, recent releases, or any information that requires up-to-date data from the internet. This will take a moment to gather the latest information. Do NOT use this for information I already have (like crypto prices from our API, NGN rates, or general crypto knowledge).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or question to search for on the web'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'initiate_swap',
      description: 'Initiate a token swap (exchange one crypto for another)',
      parameters: {
        type: 'object',
        properties: {
          fromToken: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'Token to swap from'
          },
          toToken: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'Token to swap to'
          },
          amount: {
            type: 'number',
            description: 'Amount of fromToken to swap'
          },
          fromNetwork: {
            type: 'string',
            enum: ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'ERC20', 'SOL', 'SOLANA', 'TRX', 'TRON', 'TRC20', 'BSC', 'BNB SMART CHAIN', 'BEP20', 'BINANCE', 'POLYGON', 'AVALANCHE'],
            description: 'Network for fromToken'
          },
          toNetwork: {
            type: 'string',
            enum: ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'ERC20', 'SOL', 'SOLANA', 'TRX', 'TRON', 'TRC20', 'BSC', 'BNB SMART CHAIN', 'BEP20', 'BINANCE', 'POLYGON', 'AVALANCHE'],
            description: 'Network for toToken'
          }
        },
        required: ['fromToken', 'toToken', 'amount', 'fromNetwork', 'toNetwork']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_quote_price',
      description: 'Get a general price quote for any token in NGN (selling rate)',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token'
          },
          amount: {
            type: 'number',
            description: 'Amount in token units'
          }
        },
        required: ['token', 'amount']
      }
    }
  }
];