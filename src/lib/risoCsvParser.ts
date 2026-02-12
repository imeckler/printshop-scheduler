import { parse } from 'csv-parse/sync';

export interface RisoUserData {
  userNumber: number;
  userName: string;
  totalCopies: number;
  masterCount: number;
}

export interface RisoCsvData {
  date: string;
  time: string;
  model: string;
  serial: string;
  users: RisoUserData[];
}

/**
 * Parse RISO usage report CSV format
 *
 * CSV Structure:
 * - Line 0: Header row with MODEL, SERIAL, etc.
 * - Line 1: Machine data (model, serial, date, time)
 * - Line 2: User data column headers (USERNUMBER, USERNAME, TC, MC, etc.)
 * - Line 3: Machine totals (no user number/name)
 * - Line 4+: Group data (G-1, G-2, etc.) and actual user data
 *
 * We extract users with numeric USERNUMBER and non-empty USERNAME
 */
export function parseRisoCsv(csvContent: string): RisoCsvData {
  // Parse CSV (allow empty fields, trim whitespace, relax column count)
  const records = parse(csvContent, {
    skip_empty_lines: false,
    relax_quotes: true,
    relax_column_count: true, // Allow rows with different field counts
    trim: true,
  }) as string[][];

  if (records.length < 4) {
    throw new Error('Invalid RISO CSV format: too few lines');
  }

  // Line 1 contains machine info: MODEL, SERIAL, FORMATVERSION, DRUMFLAG, DATE, TIME
  const machineInfo = records[1];
  const model = machineInfo[0] || 'Unknown';
  const serial = machineInfo[1] || 'Unknown';
  const date = machineInfo[4] || '';
  const time = machineInfo[5] || '';

  // Find the user data header row (contains "USERNUMBER")
  let headerIndex = -1;
  for (let i = 0; i < records.length; i++) {
    if (records[i][0] === 'USERNUMBER') {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    throw new Error('Invalid RISO CSV format: USERNUMBER header not found');
  }

  const headers = records[headerIndex];

  // Find column indices
  const userNumberIdx = headers.indexOf('USERNUMBER');
  const userNameIdx = headers.indexOf('USERNAME');
  const tcIdx = headers.indexOf('TC'); // Total Copies
  const mcIdx = headers.indexOf('MC'); // Master Count (stencils)

  if (userNumberIdx === -1 || userNameIdx === -1 || tcIdx === -1 || mcIdx === -1) {
    throw new Error('Invalid RISO CSV format: missing required columns');
  }

  const users: RisoUserData[] = [];

  // Parse user data rows (start after header)
  for (let i = headerIndex + 1; i < records.length; i++) {
    const row = records[i];

    // Skip empty rows
    if (!row || row.length === 0 || row.every(cell => !cell || cell.trim() === '')) {
      continue;
    }

    // Get user number and name
    const userNumberStr = row[userNumberIdx];
    const userName = row[userNameIdx]?.trim();

    // Skip if no user number (like machine totals or groups)
    if (!userNumberStr || userNumberStr.trim() === '') {
      continue;
    }

    const userNumber = parseInt(userNumberStr, 10);

    // Skip if not a valid number
    if (isNaN(userNumber)) {
      continue;
    }

    // Skip if no username (groups have numbers but names like "G-1")
    if (!userName || userName.trim() === '') {
      continue;
    }

    // Skip group entries (userName starts with "G-")
    if (userName.startsWith('G-')) {
      continue;
    }

    // Parse usage values
    const parseValue = (idx: number): number => {
      if (idx === -1) return 0;
      const value = row[idx];
      if (!value || value.trim() === '') return 0;
      const parsed = parseInt(value, 10);
      return isNaN(parsed) ? 0 : parsed;
    };

    const totalCopies = parseValue(tcIdx);
    const masterCount = parseValue(mcIdx);

    users.push({
      userNumber,
      userName,
      totalCopies,
      masterCount,
    });
  }

  return {
    date,
    time,
    model,
    serial,
    users,
  };
}
