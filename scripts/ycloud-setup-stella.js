// One-off: create Stella's account-moved template and the sign-up and
// sign-in Flows on YCloud, for the WhatsApp account behind YCLOUD_FROM_NUMBER.
// Reads YCLOUD_API_KEY from .env, so the key never has to be typed anywhere.
// Prints the IDs and the .env lines to add. Skips anything that already
// exists by name, so it's safe to re-run (e.g. to publish after a failure).
//
// Deploy the /whatsapp/ycloud-flow route first: Meta checks the endpoint
// when a Flow is published.
//
// Run: node scripts/ycloud-setup-stella.js
// The KYC Flow is left out on purpose: its selfie download still needs
// Meta's token (AI/stellaSender.js downloadMedia), so KYC stays on the
// bramp.shop link for now.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BASE = 'https://api.ycloud.com/v2';
const FLOW_ENDPOINT = 'https://priscaai.online/whatsapp/ycloud-flow';
const TEMPLATE_NAME = 'stella_account_moved';
const TEMPLATE_LANGUAGE = 'en';

const FLOWS = [
  { env: 'STELLA_SIGNUP_FLOW_ID', name: 'stella_signup', file: 'stella-signup.json', categories: ['SIGN_UP'] },
  { env: 'STELLA_SIGNIN_FLOW_ID', name: 'stella_signin', file: 'stella-signin.json', categories: ['SIGN_IN'] },
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

async function createTemplate(wabaId) {
  try {
    const { data } = await api.get(`/whatsapp/templates/${wabaId}/${TEMPLATE_NAME}/${TEMPLATE_LANGUAGE}`);
    console.log(`Template ${TEMPLATE_NAME} (${TEMPLATE_LANGUAGE}) already exists: ${data.status}`);
    return;
  } catch (err) {
    if (err.response?.status !== 404) console.log(`  (could not check for an existing template: ${why(err)})`);
  }
  try {
    const { data } = await api.post('/whatsapp/templates', {
      wabaId,
      name: TEMPLATE_NAME,
      language: TEMPLATE_LANGUAGE,
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: "Your Stella by Bramp account was moved to a new WhatsApp number ending in {{1}} on {{2}}. If you didn't do this, tap \"This wasn't me\" and we'll pause the account right away.",
          example: { body_text: [['1569', '8 Nov 2026, 9:43 am']] },
        },
        { type: 'FOOTER', text: 'Bramp will never ask for your PIN.' },
        { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: "This wasn't me" }] },
      ],
    });
    console.log(`Template ${TEMPLATE_NAME} submitted: ${data.status || 'PENDING'}`);
  } catch (err) {
    console.log(`Template ${TEMPLATE_NAME} FAILED: ${why(err)}`);
  }
}

async function existingFlows(wabaId) {
  try {
    const { data } = await api.get('/whatsapp/flows', { params: { wabaId, limit: 100 } });
    return data.items || [];
  } catch (err) {
    console.log(`  (could not list existing Flows: ${why(err)})`);
    return [];
  }
}

async function createFlow(wabaId, flow, existing) {
  let id = existing.find((f) => f.name === flow.name)?.id;
  if (id) {
    console.log(`Flow ${flow.name} already exists: ${id}`);
  } else {
    const flowJson = fs.readFileSync(path.join(__dirname, '..', 'AI', 'flows', flow.file), 'utf8');
    try {
      const { data } = await api.post('/whatsapp/flows', {
        wabaId, name: flow.name, categories: flow.categories, flowJson, endpointUri: FLOW_ENDPOINT, publish: false,
      });
      id = data.id;
      console.log(`Flow ${flow.name} created (draft): ${id}`);
    } catch (err) {
      console.log(`Flow ${flow.name} FAILED to create: ${why(err)}`);
      return null;
    }
  }
  try {
    await api.post(`/whatsapp/flows/${id}/publish`);
    console.log(`Flow ${flow.name} published`);
  } catch (err) {
    console.log(`Flow ${flow.name} not published: ${why(err)}`);
  }
  return id;
}

(async () => {
  if (!process.env.YCLOUD_API_KEY || !process.env.YCLOUD_FROM_NUMBER) {
    console.error('YCLOUD_API_KEY and YCLOUD_FROM_NUMBER must be set in .env');
    process.exit(1);
  }
  const wabaId = await findWabaId();
  console.log(`WhatsApp account (WABA): ${wabaId}\n`);

  await createTemplate(wabaId);
  const existing = await existingFlows(wabaId);
  const lines = [];
  for (const flow of FLOWS) {
    const id = await createFlow(wabaId, flow, existing);
    if (id) lines.push(`${flow.env}=${id}`);
  }

  console.log('\nAdd to .env (replacing the commented-out lines):');
  lines.forEach((l) => console.log(`  ${l}`));
  console.log('Once the template shows APPROVED in YCloud, also add:');
  console.log(`  STELLA_TEMPLATE_ACCOUNT_MOVED=${TEMPLATE_NAME}`);
  console.log(`  STELLA_TEMPLATE_LANGUAGE=${TEMPLATE_LANGUAGE}`);
})().catch((err) => {
  console.error('Setup failed:', why(err));
  process.exit(1);
});
