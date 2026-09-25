import { parseCSV, parseBooleanCell } from '../csv-parser';
import {
  ServiceBatchItemSchema,
  StaffBatchItemSchema,
} from '../../types/onboarding.types';

describe('CSV Parser', () => {
  describe('parseCSV', () => {
    it('should parse simple CSV with headers', () => {
      const csv = 'name,phone\nAlice,+1234567890\nBob,+0987654321';
      const result = parseCSV(csv);

      expect(result).toEqual([
        { name: 'Alice', phone: '+1234567890' },
        { name: 'Bob', phone: '+0987654321' },
      ]);
    });

    it('should handle quoted fields with commas', () => {
      const csv = 'name,address\n"Smith, John","123 Main St, Apt 4"';
      const result = parseCSV(csv);

      expect(result).toEqual([
        { name: 'Smith, John', address: '123 Main St, Apt 4' },
      ]);
    });

    it('should return empty array for empty input', () => {
      expect(parseCSV('')).toEqual([]);
      expect(parseCSV('header')).toEqual([]);
    });
  });

  describe('CSV with Zod Schema Validation', () => {
    it('should parse services CSV with numeric values and coerce them', () => {
      const csv = 'title,price_min,duration\nHaircut,50,1800';
      const parsed = parseCSV(csv);

      expect(parsed).toEqual([
        { title: 'Haircut', price_min: '50', duration: '1800' },
      ]);

      // Validate with Zod schema (coercion happens during validation)
      const result = ServiceBatchItemSchema.parse(parsed[0]);
      expect(result).toEqual({
        title: 'Haircut',
        price_min: 50,
        duration: 1800,
      });
      expect(typeof result.price_min).toBe('number');
      expect(typeof result.duration).toBe('number');
    });

    it('should parse services CSV with optional numeric fields', () => {
      const csv =
        'title,price_min,price_max,duration,category_id\nManicure,30,40,1200,5';
      const parsed = parseCSV(csv);

      const result = ServiceBatchItemSchema.parse(parsed[0]);
      expect(result).toEqual({
        title: 'Manicure',
        price_min: 30,
        price_max: 40,
        duration: 1200,
        category_id: 5,
      });
      expect(typeof result.price_max).toBe('number');
      expect(typeof result.category_id).toBe('number');
    });

    it('should parse staff CSV with numeric position_id', () => {
      const csv = 'name,position_id\nAlice,3';
      const parsed = parseCSV(csv);

      const result = StaffBatchItemSchema.parse(parsed[0]);
      expect(result).toEqual({
        name: 'Alice',
        position_id: 3,
      });
      expect(typeof result.position_id).toBe('number');
    });
  });

  describe('parseBooleanCell', () => {
    it.each([
      ['true', true],
      [' YES ', true],
      ['1', true],
      ['False', false],
      ['no', false],
      ['0', false],
    ])('reads %p as %p', (cell, expected) => {
      expect(parseBooleanCell(cell)).toBe(expected);
    });

    it('reads a blank cell as no answer, never false', () => {
      expect(parseBooleanCell('')).toBeUndefined();
      expect(parseBooleanCell('   ')).toBeUndefined();
    });

    it('passes other words and non-strings through for the schema to judge', () => {
      expect(parseBooleanCell('maybe')).toBe('maybe');
      expect(parseBooleanCell(true)).toBe(true);
      expect(parseBooleanCell(undefined)).toBeUndefined();
    });

    it('parses the staff answers from CSV', () => {
      const [row] = parseCSV(
        'name,is_paid_staff,has_timetable_access\nAlice,no,yes'
      );
      expect(StaffBatchItemSchema.parse(row)).toMatchObject({
        name: 'Alice',
        is_paid_staff: false,
        has_timetable_access: true,
      });
    });
  });
});
