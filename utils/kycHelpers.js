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

module.exports = {
  classifyOutcome,
  parseFullName,
  isValidKycDocument,
  isBvnIdType,
  isNinIdType,
  APPROVED_CODES,
  PROVISIONAL_CODES,
  REJECTED_CODES
};
