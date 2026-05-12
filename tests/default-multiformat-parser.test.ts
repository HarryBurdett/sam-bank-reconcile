import { describe, it, expect } from 'vitest';
import { defaultMultiformatParser } from '../src/services/default-multiformat-parser.js';

const { detectFormat, parse } = defaultMultiformatParser;

describe('detectFormat', () => {
  it('detects OFX', () => {
    expect(detectFormat('OFXHEADER:100\nDATA:OFXSGML\n<OFX>')).toBe('ofx');
    expect(detectFormat('<OFX>')).toBe('ofx');
  });
  it('detects QIF', () => {
    expect(detectFormat('!Type:Bank\n')).toBe('qif');
  });
  it('detects MT940', () => {
    expect(detectFormat(':20:STATEMENT')).toBe('mt940');
  });
  it('detects CSV', () => {
    expect(detectFormat('Date,Amount,Description\n2026-04-15,100,Acme')).toBe('csv');
  });
  it('returns unknown for empty / unrecognised', () => {
    expect(detectFormat('')).toBe('unknown');
    expect(detectFormat('Hello world')).toBe('unknown');
  });
});

describe('parse CSV', () => {
  it('parses header + rows with date/amount/description', () => {
    const csv = `Date,Amount,Description\n2026-04-15,100,"Acme Ltd"\n2026-04-20,-50,"Energy Co"`;
    const rows = parse(csv, 'csv');
    expect(rows.length).toBe(2);
    expect(rows[0]?.date).toBe('2026-04-15');
    expect(rows[0]?.amount).toBe(100);
    expect(rows[1]?.amount).toBe(-50);
  });

  it('handles separate Debit/Credit columns', () => {
    const csv = `Date,Description,Debit,Credit\n2026-04-15,Pay,50.00,\n2026-04-16,Acme,,100.00`;
    const rows = parse(csv, 'csv');
    expect(rows[0]?.amount).toBe(-50);
    expect(rows[1]?.amount).toBe(100);
  });

  it('handles DD/MM/YYYY dates', () => {
    const csv = `Date,Amount,Description\n15/04/2026,100,Acme`;
    const rows = parse(csv, 'csv');
    expect(rows[0]?.date).toBe('2026-04-15');
  });

  it('handles 2-digit years', () => {
    const csv = `Date,Amount,Description\n15/04/26,100,Acme`;
    const rows = parse(csv, 'csv');
    expect(rows[0]?.date).toBe('2026-04-15');
  });
});

describe('parse OFX', () => {
  it('extracts STMTTRN blocks', () => {
    const ofx = `OFXHEADER:100
<OFX>
<STMTTRN>
<DTPOSTED>20260415120000
<TRNAMT>-50.00
<NAME>Energy Co
<MEMO>Direct debit
</STMTTRN>
<STMTTRN>
<DTPOSTED>20260420120000
<TRNAMT>100.00
<NAME>Acme Ltd
</STMTTRN>
</OFX>`;
    const rows = parse(ofx, 'ofx');
    expect(rows.length).toBe(2);
    expect(rows[0]?.date).toBe('2026-04-15');
    expect(rows[0]?.amount).toBe(-50);
    expect(rows[1]?.name).toBe('Acme Ltd');
  });
});

describe('parse QIF', () => {
  it('parses QIF blocks', () => {
    const qif = `!Type:Bank
D2026-04-15
T-50.00
PEnergy Co
MDirect debit
^
D2026-04-20
T100.00
PAcme Ltd
^`;
    const rows = parse(qif, 'qif');
    expect(rows.length).toBe(2);
    expect(rows[0]?.amount).toBe(-50);
    expect(rows[0]?.name).toBe('Energy Co');
  });
});

describe('parse MT940', () => {
  it('extracts :61: lines', () => {
    const mt = `:20:STATEMENT
:25:12345678
:60F:C260415GBP1000,00
:61:260415C100,00NTRF
:86:Acme payment
:61:260420D50,00NTRF
:86:Energy DD
:62F:C260430GBP1050,00`;
    const rows = parse(mt, 'mt940');
    expect(rows.length).toBe(2);
    expect(rows[0]?.amount).toBe(100);
    expect(rows[1]?.amount).toBe(-50);
  });
});

describe('parse fallback', () => {
  it('returns empty for unknown', () => {
    expect(parse('garbage', 'unknown')).toEqual([]);
  });
});
