// utils/kycHelpers.js
const logger = require('./logger');

// Youverify result codes
const APPROVED_CODES = new Set([
  '0810', '0820', '0830', '0840',
  '1012', '1020', '1021',
  '1210', '1220', '1230', '1240',
  '2302'
]);

const PROVISIONAL_CODES = new Set([
  '0812', '0814', '0815', '0816', '0817',
  '0822', '0824', '0825',
  '1212', '1213', '1214', '1215',
  '1222', '1223', '1224', '1225'
]);

const REJECTED_CODES = new Set([
  '0813', '0826', '0827',
  '1011', '1013', '1014', '1015', '1016',
  '1216', '1217', '1218', '1226', '1227', '1228'
]);

/**
 * Classify KYC verification outcome based on job success, result codes, text, and actions
 */
function classifyOutcome({ job_success, code, text, actions, status, allValidationPassed }) {
  if (typeof job_success === 'boolean') {
    return job_success ? 'APPROVED' : 'REJECTED';
  }

  if (status) {
    const statusStr = String(status).toLowerCase();
    if (statusStr === 'pending') return 'PROVISIONAL';
    if (statusStr === 'found' && allValidationPassed === true) return 'APPROVED';
    if (statusStr === 'not_found' || (statusStr === 'found' && allValidationPassed === false)) {
      return 'REJECTED';
    }
  }

  const codeStr = String(code || '');
  if (APPROVED_CODES.has(codeStr)) return 'APPROVED';
  if (REJECTED_CODES.has(codeStr)) return 'REJECTED';
  if (PROVISIONAL_CODES.has(codeStr)) return 'PROVISIONAL';

  const t = (text || '').toLowerCase();

  if (/(fail|rejected|no.?match|unable|unsupported|error|invalid|not.?found|not.?enabled|cannot|declined)/.test(t)) {
    return 'REJECTED';
  }

  if (/(provisional|pending|awaiting|under.?review|partial.?match)/.test(t)) {
    return 'PROVISIONAL';
  }

  if (/(pass|approved|verified|valid|exact.?match|enroll.?user|id.?validated|success)/.test(t)) {
    return 'APPROVED';
  }

  if (actions && typeof actions === 'object') {
    const vals = Object.values(actions).map(v => String(v).toLowerCase());
    const criticalActions = ['verify_id_number', 'selfie_to_id_authority_compare', 'human_review_compare'];

    const criticalFailed = criticalActions.some(action => {
      const actionValue = actions[action];
      return actionValue && /(fail|rejected|unable|not.applicable)/.test(String(actionValue).toLowerCase());
    });

    if (criticalFailed) return 'REJECTED';

    const anyFail = vals.some(v => /(fail|rejected|unable)/.test(v));
    const mostPass = vals.filter(v => /(pass|approved|verified|returned|completed)/.test(v)).length > vals.length / 2;

    if (anyFail && !mostPass) return 'REJECTED';
    if (mostPass) return 'APPROVED';
  }

  logger.warn('Unknown verification outcome - defaulting to REJECTED', { code: codeStr, text: t, job_success, status });
  return 'REJECTED';
}

function parseFullName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return { firstName: null, lastName: null, middleName: null };
  }
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null, middleName: null };
  if (parts.length === 2) return { firstName: parts[0], lastName: parts[1], middleName: null };
  return { firstName: parts[0], middleName: parts.slice(1, -1).join(' '), lastName: parts[parts.length - 1] };
}

function isValidKycDocument(idType) {
  if (!idType) return false;
  return ['bvn', 'national_id', 'passport', 'drivers_license', 'nin_slip', 'voter_id', 'nin'].includes(idType.toLowerCase());
}

function isBvnIdType(idType) {
  return !!(idType && idType.toLowerCase() === 'bvn');
}

function isNinIdType(idType) {
  return !!(idType && ['nin', 'nin_slip', 'national_id'].includes(idType.toLowerCase()));
}

/**
 * Compare two full names regardless of word order (e.g. "John Musa Doe" vs
 * "Doe John Musa" match) or casing. Deliberately lenient - not a strict
 * equality check - so a rearranged or differently-cased name still matches.
 * Used to compare a bank transfer sender's name against a user's own
 * registered name (e.g. virtual account deposit fraud check).
 * @param {string} nameA
 * @param {string} nameB
 * @returns {boolean} True if both names contain the same set of words
 */
function namesMatch(nameA, nameB) {
  const tokenize = (name) =>
    (name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .sort();

  const tokensA = tokenize(nameA);
  const tokensB = tokenize(nameB);

  if (tokensA.length === 0 || tokensB.length === 0) return false;

  // Every token in the shorter name must appear in the longer name.
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every((token) => longer.includes(token));
}

/**
 * Looser than namesMatch: true if the two names share at least one word,
 * rather than requiring every word of the shorter name to appear in the
 * longer one. Used as a fallback when a full name match fails - a person's
 * name on file may hold only part of what's on their ID (added/reordered
 * legal names, e.g. profile "Abdul Yahaya" vs ID "Yahaya Abdul Basit
 * Omeiza" - these already pass namesMatch, but a case with no full-subset
 * overlap at all, e.g. only a shared middle name, still shouldn't be a hard
 * rejection when the selfie face-match confirms identity).
 * @param {string} nameA
 * @param {string} nameB
 * @returns {boolean} True if the names share at least one word
 */
function namesPartiallyOverlap(nameA, nameB) {
  const tokenize = (name) =>
    (name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const tokensA = tokenize(nameA);
  const tokensB = tokenize(nameB);

  if (tokensA.length === 0 || tokensB.length === 0) return false;

  return tokensA.some((token) => tokensB.includes(token));
}

/**
 * Jaro similarity (0-1) between two strings - foundation for Jaro-Winkler.
 */
function jaroSimilarity(s1, s2) {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Jaro-Winkler similarity (0-1): Jaro similarity boosted for strings that
 * share a common prefix (up to 4 chars). Industry-standard algorithm for
 * name matching (OFAC sanctions screening, UK Confirmation of Payee).
 * Unlike word-overlap matching, it scores the strings as a whole, so a
 * single shared word can't produce a false "match" on its own.
 */
function jaroWinklerSimilarity(s1, s2, prefixScale = 0.1) {
  const jaro = jaroSimilarity(s1, s2);
  const maxPrefix = 4;
  let prefixLength = 0;
  for (let i = 0; i < Math.min(maxPrefix, s1.length, s2.length); i++) {
    if (s1[i] !== s2[i]) break;
    prefixLength++;
  }
  return jaro + prefixLength * prefixScale * (1 - jaro);
}

/**
 * Normalize a name to a canonical, order-independent form for similarity
 * scoring: lowercase, strip non-letters, sort words alphabetically and
 * join - so "Godspower Odion" and "Odion Godspower" compare identically.
 */
function normalizeNameForSimilarity(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Whole-name similarity score (0-1) between two names, order-independent
 * and tolerant of minor typos, via Jaro-Winkler.
 */
function nameSimilarityScore(nameA, nameB) {
  const normA = normalizeNameForSimilarity(nameA);
  const normB = normalizeNameForSimilarity(nameB);
  if (!normA || !normB) return 0;
  return jaroWinklerSimilarity(normA, normB);
}

/**
 * True if two names are similar enough to be considered the same person.
 * Jaro-Winkler score >= threshold (0.85 default - tolerates typos and word
 * reordering, but rejects names that are substantially different, unlike
 * namesPartiallyOverlap which passes on a single shared word).
 */
function namesSimilar(nameA, nameB, threshold = 0.85) {
  return nameSimilarityScore(nameA, nameB) >= threshold;
}

module.exports = {
  classifyOutcome,
  parseFullName,
  isValidKycDocument,
  isBvnIdType,
  isNinIdType,
  namesMatch,
  namesPartiallyOverlap,
  jaroWinklerSimilarity,
  nameSimilarityScore,
  namesSimilar,
  APPROVED_CODES,
  PROVISIONAL_CODES,
  REJECTED_CODES
};
