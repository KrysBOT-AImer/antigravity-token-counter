import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isInternalWorkerModel } from './settings.mjs';

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_CACHE_ENTRIES = 100;
const textDecoder = new TextDecoder('utf-8', { fatal: false });

const genMetaCache = new Map(); // dbPath -> { cacheSig, value }

function readVarint(buf, pos, end) {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  while (i < end && i - pos < 10) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: i };
    }
    shift += 7n;
  }
  return null;
}

function scanLengthDelimitedFields(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const tagVarint = readVarint(buf, pos, end);
    if (!tagVarint) break;
    pos = tagVarint.next;

    const fieldNumber = Number(tagVarint.value >> 3n);
    const wireType = Number(tagVarint.value & 7n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) break;

    if (wireType === 0) {
      const val = readVarint(buf, pos, end);
      if (!val) break;
      pos = val.next;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, pos, end);
      if (!lenVarint) break;
      const remaining = BigInt(end - lenVarint.next);
      if (lenVarint.value < 0n || lenVarint.value > remaining) break;
      const len = Number(lenVarint.value);
      const sliceStart = lenVarint.next;
      const sliceEnd = sliceStart + len;
      pos = sliceEnd;
      onField(fieldNumber, sliceStart, sliceEnd);
    } else {
      // Unsupported/deprecated wire types (3, 4, 6, 7): stop safely
      break;
    }
  }
}

function decodeUtf8(buf, start, end) {
  if (end <= start) return '';
  return textDecoder.decode(buf.subarray(start, end)).trim();
}

/**
 * Safely extract model metadata fields from a `gen_metadata.data` protobuf blob.
 * Returns `{ modelId, requestModelId, displayLabel, bestModel }`.
 */
export function extractModelFromGenMetadataBlob(buf) {
  const empty = {
    modelId: '',
    requestModelId: '',
    displayLabel: '',
    bestModel: '',
  };

  if (!buf || !ArrayBuffer.isView(buf)) {
    return empty;
  }

  const bytes =
    buf instanceof Uint8Array
      ? buf
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  if (bytes.byteLength === 0) {
    return empty;
  }

  let modelId = '';
  let requestModelId = '';
  let displayLabel = '';

  scanLengthDelimitedFields(bytes, 0, bytes.byteLength, (field, start, end) => {
    if (field === 1) {
      scanLengthDelimitedFields(bytes, start, end, (nestedField, nStart, nEnd) => {
        if (nestedField === 19) {
          const val = decodeUtf8(bytes, nStart, nEnd);
          if (val) modelId = val;
        } else if (nestedField === 21) {
          const val = decodeUtf8(bytes, nStart, nEnd);
          if (val) displayLabel = val;
        }
      });
    } else if (field === 3) {
      scanLengthDelimitedFields(bytes, start, end, (nestedField, nStart, nEnd) => {
        if (nestedField === 28) {
          const val = decodeUtf8(bytes, nStart, nEnd);
          if (val) requestModelId = val;
        }
      });
    }
  });

  const bestModel = modelId || requestModelId || displayLabel;
  return {
    modelId,
    requestModelId,
    displayLabel,
    bestModel,
  };
}

function touchCache(dbPath, cacheSig, value) {
  genMetaCache.delete(dbPath);
  genMetaCache.set(dbPath, { cacheSig, value });
  while (genMetaCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = genMetaCache.keys().next().value;
    genMetaCache.delete(oldestKey);
  }
}

/**
 * Clear the in-memory `gen_metadata` LRU cache.
 */
export function clearGenMetadataCache() {
  genMetaCache.clear();
}

/**
 * Read the latest model metadata from `<appDataDir>/conversations/<convId>.db` (`gen_metadata`).
 * Opens the SQLite file read-only with a short busy timeout and closes it immediately.
 * Caches decoded results in an LRU Map invalidated by main DB + WAL file stats.
 */
export function readSessionModelFromGenMetadata(appDataDir, convId) {
  if (typeof appDataDir !== 'string' || !appDataDir || typeof convId !== 'string' || !SAFE_ID_RE.test(convId)) {
    return null;
  }

  const dbPath = join(appDataDir, 'conversations', `${convId}.db`);
  let st;
  try {
    st = statSync(dbPath, { bigint: true });
  } catch {
    genMetaCache.delete(dbPath);
    return null;
  }

  let walMtimeNs = 0n;
  let walSize = 0n;
  try {
    const walSt = statSync(`${dbPath}-wal`, { bigint: true });
    walMtimeNs = walSt.mtimeNs;
    walSize = walSt.size;
  } catch {
    // WAL file may not exist
  }

  const cacheSig = `${st.ino}:${st.birthtimeNs}:${st.mtimeNs}:${st.size}:${walMtimeNs}:${walSize}`;
  const hit = genMetaCache.get(dbPath);
  if (hit && hit.cacheSig === cacheSig) {
    touchCache(dbPath, cacheSig, hit.value);
    return hit.value ? { ...hit.value } : null;
  }

  let db = null;
  let value = null;
  let shouldCache = true;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 300');
    const rows = db
      .prepare('SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 50')
      .all();
    let workerFallback = null;
    for (const row of rows) {
      if (!row || !row.data) continue;
      const extracted = extractModelFromGenMetadataBlob(row.data);
      if (!extracted.bestModel) continue;
      const candidate = {
        model: extracted.bestModel,
        displayLabel: extracted.displayLabel,
        cacheSig,
      };
      if (!isInternalWorkerModel(extracted.bestModel)) {
        value = candidate;
        break;
      }
      if (!workerFallback) {
        workerFallback = candidate;
      }
    }
    if (!value && workerFallback) {
      value = workerFallback;
    }
  } catch (err) {
    const msg = String(err?.message || '');
    // Do not cache transient lock/busy/Windows sharing errors so the next poll retries
    if (
      err?.code === 'EBUSY' ||
      err?.code === 'EACCES' ||
      err?.code === 'EPERM' ||
      /busy|locked|unable to open/i.test(msg)
    ) {
      shouldCache = false;
    }
    value = null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }

  if (shouldCache) {
    touchCache(dbPath, cacheSig, value);
  }
  return value ? { ...value } : null;
}
