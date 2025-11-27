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
