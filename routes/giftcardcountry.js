// routes/giftcardcountry.js
const express = require('express');
const router = express.Router();
const GiftCardPrice = require('../models/giftcardPrice');

function normalizeCardType(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const includes = (t) => s.indexOf(t) !== -1;

  if (includes('apple') || includes('itunes')) return { cardType: 'APPLE' };
  if (includes('steam')) return { cardType: 'STEAM' };
  if (includes('nord') || includes('nordstrom')) return { cardType: 'NORDSTROM' };
  if (includes('macy')) return { cardType: 'MACY' };
  if (includes('nike')) return { cardType: 'NIKE' };
  if (includes('google') || includes('googleplay') || includes('google_play') || includes('playstore')) return { cardType: 'GOOGLE_PLAY' };
  if (includes('amazon')) return { cardType: 'AMAZON' };
  if (includes('american') || includes('amex') || includes('american_express') || includes('american-express')) return { cardType: 'AMERICAN_EXPRESS' };
  if (includes('sephora')) return { cardType: 'SEPHORA' };
  if (includes('foot') || includes('footlocker')) return { cardType: 'FOOTLOCKER' };
  if (includes('xbox')) return { cardType: 'XBOX' };
  if (includes('ebay')) return { cardType: 'EBAY' };
  if (includes('razor') || includes('razor_gold') || includes('razer')) return { cardType: 'RAZOR_GOLD' };

  if (includes('vanilla') || includes('4097') || includes('4118')) {
    const vanillaType = s.includes('4097') ? '4097' : (s.includes('4118') ? '4118' : undefined);
    return { cardType: 'VANILLA', vanillaType };
  }

  if (includes('visa')) return { cardType: 'VISA' };

  const token = s.replace(/[^a-z0-9]/g, '').toUpperCase();
  if (token === 'GOOGLEPLAY' || token === 'GOOGLE_PLAY') return { cardType: 'GOOGLE_PLAY' };
  if (token === 'RAZORGOLD' || token === 'RAZOR_GOLD') return { cardType: 'RAZOR_GOLD' };
  if (token === 'AMERICANEXPRESS' || token === 'AMERICAN_EXPRESS') return { cardType: 'AMERICAN_EXPRESS' };

  const known = ['APPLE','STEAM','NORDSTROM','MACY','NIKE','AMAZON','VISA','VANILLA','SEPHORA','FOOTLOCKER','XBOX','EBAY'];
  if (known.includes(token)) return { cardType: token };

  return null;
}

function getCountryDisplayName(countryCode) {
  const countryNames = { 'US': 'United States', 'CANADA': 'Canada', 'AUSTRALIA': 'Australia', 'SWITZERLAND': 'Switzerland', 'EUROPE': 'Europe' };
  return countryNames[countryCode] || countryCode;
}

function getCardTypeDisplayName(cardType) {
  const cardTypeNames = {
    'APPLE': 'Apple/iTunes', 'STEAM': 'Steam', 'NORDSTROM': 'Nordstrom', 'MACY': "Macy's",
    'NIKE': 'Nike', 'GOOGLE_PLAY': 'Google Play', 'AMAZON': 'Amazon', 'VISA': 'Visa',
    'VANILLA': 'Vanilla (4097 / 4118)', 'RAZOR_GOLD': 'Razor Gold', 'AMERICAN_EXPRESS': 'American Express',
    'SEPHORA': 'Sephora', 'FOOTLOCKER': 'Footlocker', 'XBOX': 'Xbox', 'EBAY': 'eBay'
  };
  return cardTypeNames[cardType] || cardType;
}

// GET /giftcardcountry/:cardType/countries
router.get('/:cardType/countries', async (req, res) => {
  try {
    const { cardType: rawCardType } = req.params;

    if (!rawCardType) {
      return res.status(400).json({ success: false, message: 'Card type parameter is required' });
    }

    const normalized = normalizeCardType(rawCardType);
    if (!normalized) {
      return res.status(400).json({ success: false, message: `Unable to map card type "${rawCardType}" to a known cardType` });
    }

    const { cardType, vanillaType } = normalized;
    const options = {};
    if (vanillaType) options.vanillaType = vanillaType;

    const countries = await GiftCardPrice.getCountriesForCard(cardType, options);

    if (!countries || countries.length === 0) {
      return res.status(404).json({ success: false, message: `No active countries found for ${cardType} gift cards`, data: { cardType, countries: [] } });
    }

    const formattedCountries = countries.map(row => ({
      code: row.country,
      name: getCountryDisplayName(row.country),
      rate: row.rate,
      rateDisplay: `${row.rate}/${row.sourceCurrency}`,
      sourceCurrency: row.sourceCurrency,
      vanillaType: row.vanillaType || (vanillaType || undefined)
    }));

    return res.status(200).json({
      success: true,
      message: `Available countries for ${cardType} retrieved successfully`,
      data: {
        cardType,
        cardTypeDisplay: getCardTypeDisplayName(cardType),
        requestedRaw: rawCardType,
        requestedNormalized: { cardType, vanillaType },
        totalCountries: countries.length,
        countries: formattedCountries
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching available countries',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

module.exports = router;
