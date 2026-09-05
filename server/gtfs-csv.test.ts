import { describe, expect, test } from "bun:test";
import { rowsToRecords } from "./gtfs-csv";

describe("GTFS CSV records", () => {
  test("preserves quoted commas, escaped quotes, and embedded newlines", () => {
    const records = Array.from(rowsToRecords('id,name\r\n1,"Stop, downtown"\r\n2,"The ""Bus"""\r\n3,"Two\nlines"'));
    expect(records).toEqual([
      { id: "1", name: "Stop, downtown" },
      { id: "2", name: 'The "Bus"' },
      { id: "3", name: "Two\nlines" },
    ]);
  });
  test("handles empty files, blank rows, and absent trailing fields", () => {
    expect(Array.from(rowsToRecords(""))).toEqual([]);
    expect(Array.from(rowsToRecords("id,name\n\n437\n\n"))).toEqual([{ id: "437", name: "" }]);
  });
  test("yields the full schedule without dropping repeated trips or after-midnight times", () => {
    expect(Array.from(rowsToRecords("trip_id,arrival_time,stop_sequence\nA,25:10:00,1\nA,25:15:00,2\nB,25:10:00,1\n"))).toEqual([
      { trip_id: "A", arrival_time: "25:10:00", stop_sequence: "1" },
      { trip_id: "A", arrival_time: "25:15:00", stop_sequence: "2" },
      { trip_id: "B", arrival_time: "25:10:00", stop_sequence: "1" },
    ]);
  });
});
