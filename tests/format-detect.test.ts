import { describe, it, expect } from 'vitest';
import {
  detectFormat,
  supportedFormats,
} from '../src/services/format-detect.js';

describe('supportedFormats', () => {
  it('lists all four formats in expected order', () => {
    expect(supportedFormats).toEqual(['CSV', 'OFX', 'QIF', 'MT940']);
  });
});

describe('detectFormat', () => {
  describe('CSV', () => {
    it('matches by .csv extension', () => {
      expect(detectFormat('anything', 'statement.csv')).toBe('CSV');
    });
    it('matches when first line contains "date"', () => {
      expect(detectFormat('Date,Amount,Description\n', '')).toBe('CSV');
    });
    it('matches when first line contains "transaction"', () => {
      expect(detectFormat('Transaction Number,Account\n', '')).toBe('CSV');
    });
    it('does NOT match a binary first line with no clue', () => {
      expect(detectFormat('foo,bar\nbaz', '')).toBeNull();
    });
  });

  describe('OFX', () => {
    it('matches .ofx extension', () => {
      expect(detectFormat('anything', 'export.ofx')).toBe('OFX');
    });
    it('matches .qfx extension', () => {
      expect(detectFormat('anything', 'export.qfx')).toBe('OFX');
    });
    it('matches OFXHEADER: in body', () => {
      expect(detectFormat('OFXHEADER:100\n<OFX>...', '')).toBe('OFX');
    });
    it('matches <?OFX in body', () => {
      // CSV is greedy on "transaction" but this content has neither;
      // <?OFX should win.
      expect(detectFormat('<?OFX VERSION="2"?>\n<OFX>', '')).toBe('OFX');
    });
    it('matches <OFX> tag in body', () => {
      expect(detectFormat('<OFX><BANKMSGSRSV1>', '')).toBe('OFX');
    });
  });

  describe('QIF', () => {
    it('matches .qif extension', () => {
      expect(detectFormat('any', 'data.qif')).toBe('QIF');
    });
    it('matches !TYPE: header', () => {
      // Note: CSV can't claim this — first line has no 'date' or 'transaction'.
      expect(detectFormat('!Type:Bank\nD01/02/2026', '')).toBe('QIF');
    });
  });

  describe('MT940', () => {
    it('matches .mt940 / .sta / .940 extensions', () => {
      expect(detectFormat('x', 'a.mt940')).toBe('MT940');
      expect(detectFormat('x', 'a.sta')).toBe('MT940');
      expect(detectFormat('x', 'a.940')).toBe('MT940');
    });
    it('matches :20: header', () => {
      expect(detectFormat(':20:REFERENCE\n:25:ACCOUNT', '')).toBe('MT940');
    });
    it('matches {1: SWIFT-style header', () => {
      expect(detectFormat('{1:F01BANKABCD}', '')).toBe('MT940');
    });
    it('matches :60F: in body', () => {
      // Avoid 'date'/'transaction' so CSV doesn't claim it.
      expect(detectFormat('foo\n:60F:C260415EUR1000,', '')).toBe('MT940');
    });
    it('matches :61: in body', () => {
      expect(detectFormat('foo\n:61:2604150415CR50,00', '')).toBe('MT940');
    });
  });

  it('returns null for completely unrecognised content', () => {
    expect(detectFormat('hello world', 'data.bin')).toBeNull();
  });
});
