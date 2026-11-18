// One-off: submit the Storefront customer-message templates to YCloud for the
// WhatsApp account behind YCLOUD_FROM_NUMBER. Stella sends these instead of a
// free-form message when the customer last wrote more than 24 hours ago
// (services/storefrontSell.js tellCustomer). Reads YCLOUD_API_KEY from .env.
// Skips any template that already exists, so it's safe to re-run.
//
// Run: node scripts/ycloud-storefront-templates.js
// Then, once YCloud shows them APPROVED, these .env lines switch them on:
//   STELLA_TEMPLATE_DEPOSIT_RECEIVED, STELLA_TEMPLATE_DEPOSIT_NEEDS_ACCOUNT,
//   STELLA_TEMPLATE_PAYOUT_SENT, and STELLA_TEMPLATE_LANGUAGE=en
// Body variables are in the order tellCustomer's params send them. Meta refuses
// a template that starts or ends on a variable, or has too many variables for
// its length, so each ends in plain text.
require('dotenv').config();
const axios = require('axios');

const BASE = 'https://api.ycloud.com/v2';
const LANGUAGE = 'en'; // same as stella_account_moved, so one STELLA_TEMPLATE_LANGUAGE covers all

const TEMPLATES = [
  {
    env: 'STELLA_TEMPLATE_DEPOSIT_RECEIVED',
    name: 'stella_deposit_received',
    text: "✅ We've received your {{1}} {{2}} at {{3}}. We're paying you now at the live rate and will message you as soon as it's sent. Your reference is {{4}}, keep it for any questions about this sale.",
    example: ['100', 'USDT', 'Ada Exchange', 'SFS-1A2B3C4D5E'],
  },
  {
    env: 'STELLA_TEMPLATE_DEPOSIT_NEEDS_ACCOUNT',
    name: 'stella_deposit_needs_account',
    text: "✅ We've received your {{1}} {{2}} at {{3}}. To get paid, reply to this message with your bank name and 10-digit account number. Your reference is {{4}}, keep it for any questions about this sale.",
    example: ['100', 'USDT', 'Ada Exchange', 'SFS-1A2B3C4D5E'],
  },
  {
    env: 'STELLA_TEMPLATE_PAYOUT_SENT',
    name: 'stella_payout_sent',
    text: "💸 Your money has been sent! We paid {{1}} into your {{2}} account for the {{3}} you sold, at a rate of {{4}}. It should show in your bank shortly. Your reference is {{5}}, keep it for any questions about this payment.",
    example: ['₦144,000.00', 'GTBank ••6789', '100 USDT', '₦1,440.00 per USDT', 'SFS-1A2B3C4D5E'],
  },
];

const api = axios.create({
  baseURL: BASE,
  timeout: 30000,
  headers: { 'X-API-Key': process.env.YCLOUD_API_KEY, 'Content-Type': 'application/json' },
});
const digits = (v) => String(v || '').replace(/[^\d]/g, '');
const why = (err) => JSON.stringify(err.response?.data || err.message);

async function findWabaId() {
  if (process.env.YCLOUD_WABA_ID) return process.env.YCLOUD_WABA_ID;
  const { data } = await api.get('/whatsapp/phoneNumbers', { params: { limit: 100 } });
  const want = digits(process.env.YCLOUD_FROM_NUMBER);
  const hit = (data.items || []).find((p) => digits(p.phoneNumber) === want);
  if (!hit) throw new Error(`No YCloud phone number matches YCLOUD_FROM_NUMBER. Found: ${(data.items || []).map((p) => p.phoneNumber).join(', ') || 'none'}`);
  return hit.wabaId;
}

async function submit(wabaId, t) {
  try {
    const { data } = await api.get(`/whatsapp/templates/${wabaId}/${t.name}/${LANGUAGE}`);
    console.log(`${t.name}: already exists (${data.status})${data.reason ? ` - ${data.reason}` : ''}`);
    return;
  } catch (err) {
    if (err.response?.status !== 404) console.log(`  (could not check ${t.name}: ${why(err)})`);
  }
  try {
    const { data } = await api.post('/whatsapp/templates', {
      wabaId,
      name: t.name,
      language: LANGUAGE,
      category: 'UTILITY',
      components: [{ type: 'BODY', text: t.text, example: { body_text: [t.example] } }],
    });
    console.log(`${t.name}: submitted (${data.status || 'PENDING'})`);
  } catch (err) {
    console.log(`${t.name}: FAILED ${why(err)}`);
  }
}

(async () => {
  if (!process.env.YCLOUD_API_KEY || !process.env.YCLOUD_FROM_NUMBER) {
    console.error('YCLOUD_API_KEY and YCLOUD_FROM_NUMBER must be set in .env');
    process.exit(1);
  }
  const wabaId = await findWabaId();
  console.log(`WhatsApp account (WABA): ${wabaId}\n`);
  for (const t of TEMPLATES) await submit(wabaId, t);
  console.log('\nOnce they show APPROVED in YCloud, .env needs:');
  TEMPLATES.forEach((t) => console.log(`  ${t.env}=${t.name}`));
  console.log(`  STELLA_TEMPLATE_LANGUAGE=${LANGUAGE}`);
})().catch((err) => {
  console.error('Failed:', why(err));
  process.exit(1);
});
