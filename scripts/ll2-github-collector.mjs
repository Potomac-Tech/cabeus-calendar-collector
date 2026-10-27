import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const RECEIVER_ORIGIN = 'https://cabeus-space-calendar-preview.jake-249.workers.dev';
const API = `${RECEIVER_ORIGIN}/api/v1/calendar/external/ll2`;
export const SOURCE_IDS = ['ll2-launches', 'll2-events'];
const MAX_BODY = 4_000_000;
const safeCode = value => typeof value === 'string' && /^[a-z0-9_]{1,80}$/.test(value) ? value : 'collector_failed';
class CollectorError extends Error { constructor(code) { super(code); this.code = code; } }

export function validateFetchUrl(value, sourceId) {
  const url = new URL(value);
  const kind = sourceId === 'll2-launches' ? 'launches' : sourceId === 'll2-events' ? 'events' : null;
  if (!kind || url.origin !== 'https://ll.thespacedevs.com' || url.username || url.password || url.hash || url.port || url.pathname !== `/2.3.0/${kind}/upcoming/`) throw new CollectorError('unsafe_source_url');
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length || keys.some(key => !['limit', 'offset'].includes(key)) || url.searchParams.get('limit') !== '100') throw new CollectorError('unsafe_source_url');
  const offset = url.searchParams.get('offset');
  if (offset !== null && (!/^\d{1,7}$/.test(offset) || Number(offset) > 1_000_000)) throw new CollectorError('unsafe_source_url');
  return url.href;
}

async function limitedText(response, maxBytes) {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) { await response.body?.cancel(); throw new CollectorError('response_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new CollectorError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function boundedFetch(fetcher, url, init, maxBytes, timeoutMs, discardStatuses = []) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal });
    // Retry-After is authoritative even when a provider's error body is huge
    // or malformed. No representation is needed to record that cooldown.
    if (discardStatuses.includes(response.status)) { await response.body?.cancel(); return { response, body: '' }; }
    return { response, body: await limitedText(response, maxBytes) };
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw new CollectorError(controller.signal.aborted ? 'upstream_timeout' : 'upstream_network_error');
  } finally { clearTimeout(timer); }
}

export async function runCollector({ token, runId, fetcher = fetch, now = () => new Date(), log = console.log } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new CollectorError('collector_token_missing');
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(runId)) throw new CollectorError('invalid_run_id');
  async function receiver(operation, input) {
    // Every retry sends exactly the same grant/response. It never repeats an
    // upstream request. Neither redirects nor environment URLs receive secrets.
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { response, body } = await boundedFetch(fetcher, `${API}/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }, 32_000, 30_000);
        let payload; try { payload = JSON.parse(body); } catch { throw new CollectorError('receiver_invalid_json'); }
        if (!response.ok) throw new CollectorError(`receiver_${response.status}`);
        return payload;
      } catch (error) {
        lastError = error;
        if (error instanceof CollectorError && /^receiver_[234]\d\d$/.test(error.code)) break;
      }
    }
    throw lastError;
  }
  const outcomes = [];
  for (const sourceId of SOURCE_IDS) {
    try {
      const grant = await receiver('claim', { sourceId, runId });
      if (grant.sourceId !== sourceId) throw new CollectorError('invalid_claim');
      if (grant.status === 'deferred') { const outcome = { sourceId, status: 'deferred', code: safeCode(grant.reason) }; outcomes.push(outcome); log(JSON.stringify(outcome)); continue; }
      if (grant.status !== 'claimed' || typeof grant.claimId !== 'string' || !/^[a-f0-9-]{36}$/.test(grant.claimId) || !Number.isFinite(Date.parse(grant.createdAt)) || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now().valueOf()) throw new CollectorError('invalid_claim');
      const fetchUrl = validateFetchUrl(grant.fetchUrl, sourceId);
      const headers = { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': `CabeusSpaceCalendarCollector/0.1 (+${RECEIVER_ORIGIN})` };
      for (const [key, value] of Object.entries(grant.conditionalHeaders ?? {})) {
        if (!['if-none-match', 'if-modified-since'].includes(key) || typeof value !== 'string' || value.length > 2048 || /[\r\n\u0000]/.test(value)) throw new CollectorError('invalid_claim_headers');
        headers[key] = value;
      }
      let submitted;
      try {
        const { response, body } = await boundedFetch(fetcher, fetchUrl, { method: 'GET', headers }, MAX_BODY, 15_000, [429, 503]);
        const responseHeaders = {};
        for (const key of ['content-type', 'etag', 'last-modified', 'retry-after']) {
          const value = response.headers.get(key); if (value !== null && value.length <= 1024) responseHeaders[key] = value;
        }
        submitted = { status: response.status, headers: responseHeaders, body };
      } catch (error) { submitted = { error: ['upstream_timeout', 'response_too_large'].includes(error.code) ? error.code : 'upstream_network_error' }; }
      const result = await receiver('submit', { sourceId, runId, claimId: grant.claimId, fetchedAt: now().toISOString(), response: submitted });
      if (result.sourceId !== sourceId || result.claimId !== grant.claimId || !['succeeded', 'failed'].includes(result.status)) throw new CollectorError('invalid_submit_result');
      const outcome = { sourceId, status: result.status, ...(Number.isSafeInteger(result.recordCount) ? { recordCount: result.recordCount } : {}), ...(result.code ? { code: safeCode(result.code) } : {}) };
      outcomes.push(outcome); log(JSON.stringify(outcome));
    } catch (error) { const outcome = { sourceId, status: 'failed', code: safeCode(error.code) }; outcomes.push(outcome); log(JSON.stringify(outcome)); }
  }
  return outcomes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = process.env.GITHUB_RUN_ID ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : `manual-${randomUUID()}`;
  try {
    const outcomes = await runCollector({ token: process.env.CABEUS_LL2_COLLECTOR_TOKEN, runId });
    if (outcomes.some(outcome => outcome.status === 'failed')) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', code: safeCode(error.code) })); process.exitCode = 1; }
}
