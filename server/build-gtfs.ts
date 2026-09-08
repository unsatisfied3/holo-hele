import { buildGtfsSnapshot } from "./gtfs";

await buildGtfsSnapshot(Bun.env.GTFS_INDEX_PATH ?? ".cache/gtfs-index.bin");
