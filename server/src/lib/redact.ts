export function redactPhi(input: string): string {
  return input
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_ID]')
    .replace(/\b(?:DOB|Date of Birth)\s*[:=-]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi, 'DOB: [REDACTED_DATE]')
    .replace(/\b(?:MRN|Medical Record(?: Number)?)\s*[:#=-]?\s*[A-Z0-9-]{4,}\b/gi, 'MRN: [REDACTED_ID]')
    .replace(/\b(?!\d{4}-\d{2}-\d{2}\b)(?:\+?\d[\d .()/-]{7,}\d)\b/g, '[REDACTED_PHONE]')
    .replace(/\bPatient\s*:\s*[A-Z][A-Za-z' -]{1,60}/g, 'Patient: [REDACTED_NAME]');
}
