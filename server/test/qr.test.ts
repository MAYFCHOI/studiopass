import { it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { qrPayload, parseQr } from '../src/qr.js';
it('signs and verifies member QR', () => {
  const db = openDb(':memory:');
  const p = qrPayload(db, 'abc123XYZ000');
  expect(p).toMatch(/^AM2:abc123XYZ000:[0-9a-f]{16}$/);
  expect(parseQr(db, p)).toBe('abc123XYZ000');
  expect(parseQr(db, p.slice(0, -1) + (p.endsWith('0') ? '1' : '0'))).toBeNull();
  expect(parseQr(db, 'AM1:m_0099gm:abcdef')).toBeNull();
  expect(parseQr(openDb(':memory:'), p)).toBeNull(); // 다른 비밀키
});
