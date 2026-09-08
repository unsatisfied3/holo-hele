function* parseCsv(text: string): Generator<string[]> {
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some(Boolean)) yield row;
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    if (row.some(Boolean)) yield row;
  }

}

/** Yield one CSV record at a time instead of duplicating the entire GTFS feed. */
export function* rowsToRecords(text: string): Generator<Record<string, string>> {
  const rows = parseCsv(text);
  const first = rows.next();
  const headers: string[] = first.done ? [] : first.value;
  let count = 0;
  for (const values of rows) {
    const record: Record<string, string> = {};
    for (let index = 0; index < headers.length; index++) record[headers[index]] = values[index] ?? "";
    yield record;
    // The schedule has over a million rows. Reclaim temporary strings during
    // loading so Bun does not grow beyond a small hosting instance's memory.
    if (++count % 25000 === 0) Bun.gc(true);
  }
}

/** Give HTTP requests and health checks time to run during large feed imports. */
export async function* rowsToRecordsAsync(text: string): AsyncGenerator<Record<string, string>> {
  let count = 0;
  for (const record of rowsToRecords(text)) {
    yield record;
    if (++count % 1000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
