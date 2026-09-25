export interface ParsedRow {
  [key: string]: string;
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

export function parseCSV(input: string): ParsedRow[] {
  const lines = input.trim().split('\n');
  if (lines.length < 2) {
    return [];
  }

  const headers = splitCSVLine(lines[0]!);
  const rows: ParsedRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i]!);
    const row: ParsedRow = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    rows.push(row);
  }

  return rows;
}

const TRUE_CELLS = new Set(['true', 'yes', '1']);
const FALSE_CELLS = new Set(['false', 'no', '0']);

/**
 * Read a cell as a yes/no answer: true/false, yes/no or 1/0 in any case. A
 * blank cell is "not answered", never `false`; any other word is returned as
 * is for the schema to reject. Non-strings (a JSON row) pass through.
 */
export function parseBooleanCell(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cell = value.trim().toLowerCase();
  if (cell === '') return undefined;
  if (TRUE_CELLS.has(cell)) return true;
  if (FALSE_CELLS.has(cell)) return false;
  return value;
}
