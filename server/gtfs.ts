import { strFromU8, unzipSync } from "fflate";
import { rowsToRecords } from "./gtfs-csv";

import type {
  NearbyStopResult,
  DailyScheduleDeparture,
  JourneyCoordinate,
  JourneyOption,
  StopLocation,
  StopSearchResult,
  TheBusArrival,
  TrackingRouteStop,
  TripPlanResponse,
  VehicleLocation,
} from "@/types/transit";
import {
  haversineMeters,
  walkMinutesFromMeters,
} from "@/lib/thebus/stops";

const ACTIVE_GTFS_URL =
  "https://www.thebus.org/transitdata/production/google_transit.zip";

interface GtfsStop extends StopLocation {
  internalId: string;
}

interface GtfsTrip {
  tripId: string;
  routeId: string;
  serviceId: string;
  shapeId: string;
  headsign: string;
}

interface GtfsStopTime {
  stopId: string;
  sequence: number;
  arrivalTime: string;
  departureTime: string;
}

interface GtfsCalendar {
  startDate: string;
  endDate: string;
  weekdays: Record<string, boolean>;
}

interface GtfsIndex {
  stops: GtfsStop[];
  stopsById: Map<string, GtfsStop>;
  tripStopIds: Map<string, string[]>;
  routeIdsByShortName: Map<string, string[]>;
  routeShortNameById: Map<string, string>;
  routeNamesByStopId: Map<string, Set<string>>;
  trips: GtfsTrip[];
  tripStopTimes: Map<string, GtfsStopTime[]>;
  shapesById: Map<string, Array<[number, number]>>;
  calendarsByServiceId: Map<string, GtfsCalendar>;
  exceptionsByServiceId: Map<string, Map<string, number>>;
}

let gtfsIndexPromise: Promise<GtfsIndex> | null = null;

function requireGtfsFile(
  archive: Record<string, Uint8Array>,
  filename: string,
): string {
  const key = Object.keys(archive).find((entry) =>
    entry.toLowerCase().endsWith(filename.toLowerCase()),
  );
  if (!key) throw new Error(`GTFS archive is missing ${filename}.`);
  const text = strFromU8(archive[key]);
  delete archive[key];
  return text;
}

async function loadGtfsIndex(): Promise<GtfsIndex> {
  const response = await fetch(ACTIVE_GTFS_URL, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`TheBus GTFS feed returned ${response.status}.`);
  }

  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const stopRecords = rowsToRecords(requireGtfsFile(archive, "stops.txt"));
  const stopTimeRecords = rowsToRecords(
    requireGtfsFile(archive, "stop_times.txt"),
  );
  const routeRecords = rowsToRecords(requireGtfsFile(archive, "routes.txt"));
  const tripRecords = rowsToRecords(requireGtfsFile(archive, "trips.txt"));
  const shapeRecords = rowsToRecords(requireGtfsFile(archive, "shapes.txt"));
  const calendarRecords = rowsToRecords(requireGtfsFile(archive, "calendar.txt"));
  const calendarDateRecords = rowsToRecords(
    requireGtfsFile(archive, "calendar_dates.txt"),
  );
  const stopsById = new Map<string, GtfsStop>();
  const stops: GtfsStop[] = [];

  for (const record of stopRecords) {
    const lat = Number.parseFloat(record.stop_lat);
    const lng = Number.parseFloat(record.stop_lon);
    if (!record.stop_id || !record.stop_name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }

    const publicId = record.stop_code || record.stop_id;
    const stop: GtfsStop = {
      internalId: record.stop_id,
      id: publicId,
      name: record.stop_name,
      lat,
      lng,
      kind: "stop",
    };
    stops.push(stop);
    stopsById.set(record.stop_id, stop);
    stopsById.set(publicId, stop);
  }

  const tripStopTimes = new Map<string, GtfsStopTime[]>();
  const times = new Map<string, string>();
  const internTime = (value: string) => {
    const existing = times.get(value);
    if (existing !== undefined) return existing;
    times.set(value, value);
    return value;
  };

  for (const record of stopTimeRecords) {
    if (!record.trip_id || !record.stop_id) continue;
    const stop = stopsById.get(record.stop_id);
    if (!stop) continue;
    const sequence = tripStopTimes.get(record.trip_id) ?? [];
    sequence.push({
      stopId: stop.id,
      sequence: Number(record.stop_sequence),
      arrivalTime: internTime(record.arrival_time),
      departureTime: internTime(record.departure_time),
    });
    tripStopTimes.set(record.trip_id, sequence);
  }

  for (const sequence of tripStopTimes.values()) {
    sequence.sort((a, b) => a.sequence - b.sequence);
  }

  const tripStopIds = new Map(
    Array.from(tripStopTimes, ([tripId, sequence]) => [
      tripId,
      sequence.map((item) => item.stopId),
    ]),
  );

  const routeIdsByShortName = new Map<string, string[]>();
  const routeShortNameById = new Map<string, string>();
  for (const record of routeRecords) {
    if (!record.route_id || !record.route_short_name) continue;
    const key = record.route_short_name.trim().toLocaleUpperCase();
    const routeIds = routeIdsByShortName.get(key) ?? [];
    routeIds.push(record.route_id);
    routeIdsByShortName.set(key, routeIds);
    routeShortNameById.set(record.route_id, record.route_short_name.trim());
  }

  const trips: GtfsTrip[] = Array.from(tripRecords).flatMap((record) => {
    if (!record.trip_id || !record.route_id || !record.service_id) return [];
    return [
      {
        tripId: record.trip_id,
        routeId: record.route_id,
        serviceId: record.service_id,
        shapeId: record.shape_id,
        headsign: record.trip_headsign,
      },
    ];
  });
  const routeNamesByStopId = new Map<string, Set<string>>();

  for (const trip of trips) {
    const routeName = routeShortNameById.get(trip.routeId);
    const stopIds = tripStopIds.get(trip.tripId);
    if (!routeName || !stopIds) continue;
    const route = normalizeRouteShortName(routeName);

    for (const stopId of stopIds) {
      const routes = routeNamesByStopId.get(stopId) ?? new Set<string>();
      routes.add(route);
      routeNamesByStopId.set(stopId, routes);
    }
  }

  const shapeSequences = new Map<
    string,
    Array<{ position: [number, number]; sequence: number }>
  >();
  for (const record of shapeRecords) {
    const lat = Number.parseFloat(record.shape_pt_lat);
    const lng = Number.parseFloat(record.shape_pt_lon);
    if (!record.shape_id || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const sequence = shapeSequences.get(record.shape_id) ?? [];
    sequence.push({
      position: [lat, lng],
      sequence: Number(record.shape_pt_sequence),
    });
    shapeSequences.set(record.shape_id, sequence);
  }

  const shapesById = new Map(
    Array.from(shapeSequences, ([shapeId, sequence]) => [
      shapeId,
      sequence
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => item.position),
    ]),
  );

  const calendarsByServiceId = new Map<string, GtfsCalendar>();
  for (const record of calendarRecords) {
    if (!record.service_id) continue;
    calendarsByServiceId.set(record.service_id, {
      startDate: record.start_date,
      endDate: record.end_date,
      weekdays: {
        sunday: record.sunday === "1",
        monday: record.monday === "1",
        tuesday: record.tuesday === "1",
        wednesday: record.wednesday === "1",
        thursday: record.thursday === "1",
        friday: record.friday === "1",
        saturday: record.saturday === "1",
      },
    });
  }

  const exceptionsByServiceId = new Map<string, Map<string, number>>();
  for (const record of calendarDateRecords) {
    if (!record.service_id || !record.date) continue;
    const exceptions = exceptionsByServiceId.get(record.service_id) ?? new Map();
    exceptions.set(record.date, Number(record.exception_type));
    exceptionsByServiceId.set(record.service_id, exceptions);
  }

  return {
    stops,
    stopsById,
    tripStopIds,
    routeIdsByShortName,
    routeShortNameById,
    routeNamesByStopId,
    trips,
    tripStopTimes,
    shapesById,
    calendarsByServiceId,
    exceptionsByServiceId,
  };
}

function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleUpperCase();
}

function normalizeRouteShortName(value: string): string {
  return value.trim().replace(/\s+LINE$/i, "").toLocaleUpperCase();
}

function getHonoluluServiceTime(now = new Date()): {
  dateKey: string;
  displayDate: string;
  weekday: string;
  seconds: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Pacific/Honolulu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.year ?? "";
  const month = parts.month ?? "";
  const day = parts.day ?? "";
  const hour = Number(parts.hour ?? 0);
  const minute = Number(parts.minute ?? 0);
  const second = Number(parts.second ?? 0);

  return {
    dateKey: `${year}${month}${day}`,
    displayDate: `${year}-${month}-${day}`,
    weekday: (parts.weekday ?? "").toLocaleLowerCase(),
    seconds: hour * 3600 + minute * 60 + second,
  };
}

function getDailyScheduleServiceTime(date: string): ReturnType<typeof getHonoluluServiceTime> {
  if (date === "today") return getHonoluluServiceTime();
  if (date === "tomorrow") {
    return getHonoluluServiceTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return getHonoluluServiceTime();

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return getHonoluluServiceTime();
  }

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
  }).format(calendarDate).toLocaleLowerCase();

  return {
    dateKey: `${match[1]}${match[2]}${match[3]}`,
    displayDate: date,
    weekday,
    seconds: 0,
  };
}

function parseGtfsTimeSeconds(value: string): number | null {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function formatGtfsTime(value: string): string {
  const totalSeconds = parseGtfsTimeSeconds(value);
  if (totalSeconds == null) return value;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatServiceSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatWalkingDistance(distanceMeters: number): string {
  if (distanceMeters < 1000) {
    return `${Math.max(10, Math.round(distanceMeters / 10) * 10)} m`;
  }
  return `${(distanceMeters / 1000).toFixed(1)} km`;
}

function nearestShapeIndex(
  path: JourneyCoordinate[],
  coordinate: JourneyCoordinate,
  startIndex = 0,
): number {
  let nearestIndex = startIndex;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = startIndex; index < path.length; index += 1) {
    const [lat, lng] = path[index];
    const distance = (lat - coordinate[0]) ** 2 + (lng - coordinate[1]) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }

  return nearestIndex;
}

function sliceTripShape(
  path: JourneyCoordinate[] | undefined,
  board: JourneyCoordinate,
  alight: JourneyCoordinate,
  fallback: JourneyCoordinate[],
): JourneyCoordinate[] {
  if (!path?.length) return fallback;
  const boardIndex = nearestShapeIndex(path, board);
  const alightIndex = nearestShapeIndex(path, alight, boardIndex);
  const segment = path.slice(boardIndex, alightIndex + 1);
  return segment.length >= 2 ? segment : fallback;
}

function isServiceActive(
  index: GtfsIndex,
  serviceId: string,
  dateKey: string,
  weekday: string,
): boolean {
  const exception = index.exceptionsByServiceId.get(serviceId)?.get(dateKey);
  if (exception === 1) return true;
  if (exception === 2) return false;

  const calendar = index.calendarsByServiceId.get(serviceId);
  return Boolean(
    calendar &&
      dateKey >= calendar.startDate &&
      dateKey <= calendar.endDate &&
      calendar.weekdays[weekday],
  );
}

interface GtfsStopServiceSummary {
  lines: string[];
  arrivals: TheBusArrival[];
}

async function getGtfsIndex(): Promise<GtfsIndex> {
  gtfsIndexPromise ??= loadGtfsIndex().catch((error) => {
    gtfsIndexPromise = null;
    throw error;
  });
  return gtfsIndexPromise;
}

function buildStopServiceSummaries(
  index: GtfsIndex,
  stopIds: Set<string>,
  maxArrivalsPerStop = 24,
): Map<string, GtfsStopServiceSummary> {
  const serviceTime = getHonoluluServiceTime();
  const lineSets = new Map<string, Set<string>>();
  const arrivalsByStop = new Map<string, TheBusArrival[]>();

  for (const stopId of stopIds) {
    lineSets.set(stopId, new Set());
    arrivalsByStop.set(stopId, []);
  }

  for (const trip of index.trips) {
    if (
      !isServiceActive(
        index,
        trip.serviceId,
        serviceTime.dateKey,
        serviceTime.weekday,
      )
    ) {
      continue;
    }

    const routeName = index.routeShortNameById.get(trip.routeId);
    const stopTimes = index.tripStopTimes.get(trip.tripId);
    if (!routeName || !stopTimes) continue;
    const route = normalizeRouteShortName(routeName);

    for (const stopTime of stopTimes) {
      if (!stopIds.has(stopTime.stopId)) continue;
      lineSets.get(stopTime.stopId)?.add(route);

      const scheduledTime = stopTime.arrivalTime || stopTime.departureTime;
      const scheduledSeconds = parseGtfsTimeSeconds(scheduledTime);
      if (scheduledSeconds == null || scheduledSeconds < serviceTime.seconds) {
        continue;
      }

      arrivalsByStop.get(stopTime.stopId)?.push({
        id: `gtfs-${trip.tripId}-${stopTime.sequence}`,
        route,
        headsign: trip.headsign || `Route ${route}`,
        direction: trip.headsign,
        stopTime: formatGtfsTime(scheduledTime),
        estimated: false,
        canceled: false,
        minutesUntil: Math.max(
          0,
          Math.ceil((scheduledSeconds - serviceTime.seconds) / 60),
        ),
        vehicle: null,
        trip: trip.tripId,
        latitude: null,
        longitude: null,
        shape: trip.shapeId || null,
      });
    }
  }

  return new Map(
    [...stopIds].map((stopId) => {
      const arrivals = arrivalsByStop.get(stopId) ?? [];
      arrivals.sort(
        (first, second) =>
          (first.minutesUntil ?? Number.POSITIVE_INFINITY) -
          (second.minutesUntil ?? Number.POSITIVE_INFINITY),
      );
      const lines = [...(lineSets.get(stopId) ?? [])].sort((first, second) =>
        first.localeCompare(second, undefined, { numeric: true }),
      );
      return [
        stopId,
        { lines, arrivals: arrivals.slice(0, maxArrivalsPerStop) },
      ];
    }),
  );
}

export async function getGtfsStop(
  stopId: string,
): Promise<StopLocation | null> {
  const index = await getGtfsIndex();
  const stop = index.stopsById.get(stopId);
  if (!stop) return null;
  return {
    id: stop.id,
    name: stop.name,
    lat: stop.lat,
    lng: stop.lng,
    kind: stop.kind,
  };
}

export async function getGtfsStopSchedule(
  stopId: string,
): Promise<GtfsStopServiceSummary | null> {
  const index = await getGtfsIndex();
  const stop = index.stopsById.get(stopId);
  if (!stop) return null;
  return buildStopServiceSummaries(index, new Set([stop.id])).get(stop.id) ?? null;
}

export async function getGtfsDailyStopSchedule(
  stopId: string,
  routeFilter?: string,
  date: string = "today",
): Promise<{
  stop: StopLocation;
  serviceDate: string;
  routes: string[];
  departures: DailyScheduleDeparture[];
} | null> {
  const index = await getGtfsIndex();
  const stop = index.stopsById.get(stopId);
  if (!stop) return null;

  const serviceTime = getDailyScheduleServiceTime(date);
  const normalizedFilter = routeFilter
    ? normalizeRouteShortName(routeFilter)
    : null;
  const routeSet = new Set<string>();
  const departures: Array<DailyScheduleDeparture & { seconds: number }> = [];

  for (const trip of index.trips) {
    if (
      !isServiceActive(
        index,
        trip.serviceId,
        serviceTime.dateKey,
        serviceTime.weekday,
      )
    ) {
      continue;
    }

    const routeName = index.routeShortNameById.get(trip.routeId);
    const stopTimes = index.tripStopTimes.get(trip.tripId);
    if (!routeName || !stopTimes) continue;
    const route = normalizeRouteShortName(routeName);
    const stopTime = stopTimes.find((item) => item.stopId === stop.id);
    if (!stopTime) continue;

    routeSet.add(route);
    if (normalizedFilter && route !== normalizedFilter) continue;

    const scheduledTime = stopTime.departureTime || stopTime.arrivalTime;
    const seconds = parseGtfsTimeSeconds(scheduledTime);
    if (seconds == null) continue;
    departures.push({
      id: `${trip.tripId}-${stopTime.sequence}`,
      route,
      headsign: trip.headsign || `Route ${route}`,
      time: formatGtfsTime(scheduledTime),
      tripId: trip.tripId,
      seconds,
    });
  }

  departures.sort((first, second) => first.seconds - second.seconds);
  const routes = [...routeSet].sort((first, second) =>
    first.localeCompare(second, undefined, { numeric: true }),
  );

  return {
    stop: {
      id: stop.id,
      name: stop.name,
      lat: stop.lat,
      lng: stop.lng,
      kind: stop.kind,
    },
    serviceDate: serviceTime.displayDate,
    routes,
    departures: departures.map((departure) => ({
      id: departure.id,
      route: departure.route,
      headsign: departure.headsign,
      time: departure.time,
      tripId: departure.tripId,
    })),
  };
}

export async function getGtfsNearbyStops({
  lat,
  lng,
  limit = 10,
}: {
  lat: number;
  lng: number;
  limit?: number;
}): Promise<NearbyStopResult[]> {
  const index = await getGtfsIndex();
  const nearestStops = index.stops
    .map((stop) => {
      const distanceMeters = haversineMeters(lat, lng, stop.lat, stop.lng);
      return {
        stop,
        distanceMeters,
        walkMinutes: walkMinutesFromMeters(distanceMeters),
      };
    })
    .sort((first, second) => first.distanceMeters - second.distanceMeters)
    .slice(0, limit);
  const summaries = buildStopServiceSummaries(
    index,
    new Set(nearestStops.map(({ stop }) => stop.id)),
  );
  const updatedAt = new Date().toISOString();

  return nearestStops.map(({ stop, distanceMeters, walkMinutes }) => {
    const summary = summaries.get(stop.id) ?? { lines: [], arrivals: [] };
    return {
      stop: {
        id: stop.id,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        kind: stop.kind,
      },
      distanceMeters,
      walkMinutes,
      lines: summary.lines,
      arrivals: summary.arrivals,
      nextArrival: summary.arrivals[0],
      dataUpdatedAt: updatedAt,
    };
  });
}

export async function getGtfsStops(): Promise<StopLocation[]> {
  const index = await getGtfsIndex();
  return index.stops.map(({ id, name, lat, lng, kind }) => ({
    id,
    name,
    lat,
    lng,
    kind,
  }));
}

function stopSearchRank(stop: GtfsStop, query: string): number {
  const id = normalizeSearch(stop.id);
  const name = normalizeSearch(stop.name);
  if (id === query) return 0;
  if (name === query) return 1;
  if (id.startsWith(query)) return 2;
  if (name.split(/\s+/).some((word) => word.startsWith(query))) return 3;
  if (name.startsWith(query)) return 4;
  return 5;
}

export async function searchGtfsStops(
  searchQuery: string,
  limit = 8,
): Promise<StopSearchResult[]> {
  const index = await getGtfsIndex();
  const query = normalizeSearch(searchQuery.trim());
  if (!query) return [];

  return index.stops
    .filter((stop) => {
      const id = normalizeSearch(stop.id);
      const name = normalizeSearch(stop.name);
      return id.includes(query) || name.includes(query);
    })
    .sort((first, second) => {
      const rankDifference =
        stopSearchRank(first, query) - stopSearchRank(second, query);
      return (
        rankDifference ||
        first.name.localeCompare(second.name, undefined, { numeric: true })
      );
    })
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map(({ id, name, lat, lng, kind }) => ({
      id,
      name,
      lat,
      lng,
      kind,
      lines: [...(index.routeNamesByStopId.get(id) ?? [])].sort(
        (first, second) =>
          first.localeCompare(second, undefined, { numeric: true }),
      ),
    }));
}

export async function getGtfsTripPlan({
  origin,
  destination,
  limit = 4,
  planningTime = new Date(),
  arriveBy = false,
}: {
  origin: { name: string; detail: string; lat: number; lng: number };
  destination: { name: string; detail: string; lat: number; lng: number };
  limit?: number;
  planningTime?: Date;
  arriveBy?: boolean;
}): Promise<TripPlanResponse> {
  const index = await getGtfsIndex();
  const serviceTime = getHonoluluServiceTime(planningTime);
  const approximateWalkFactor = 1.2;
  const candidateRadiusMeters = 1800;
  const candidateStopLimit = 16;

  const nearestCandidates = (lat: number, lng: number) =>
    index.stops
      .map((stop) => ({
        stop,
        distanceMeters:
          haversineMeters(lat, lng, stop.lat, stop.lng) * approximateWalkFactor,
      }))
      .filter(({ distanceMeters }) => distanceMeters <= candidateRadiusMeters)
      .sort((first, second) => first.distanceMeters - second.distanceMeters)
      .slice(0, candidateStopLimit);

  const originCandidates = nearestCandidates(origin.lat, origin.lng);
  const destinationCandidates = nearestCandidates(destination.lat, destination.lng);
  const originByStop = new Map(originCandidates.map((item) => [item.stop.id, item]));
  const destinationByStop = new Map(
    destinationCandidates.map((item) => [item.stop.id, item]),
  );
  const candidates: Array<{ journey: JourneyOption; arrivalSeconds: number }> = [];

  for (const trip of index.trips) {
    if (
      !isServiceActive(
        index,
        trip.serviceId,
        serviceTime.dateKey,
        serviceTime.weekday,
      )
    ) {
      continue;
    }

    const routeName = index.routeShortNameById.get(trip.routeId);
    const stopTimes = index.tripStopTimes.get(trip.tripId);
    if (!routeName || !stopTimes?.length) continue;

    const boardOptions = stopTimes.flatMap((stopTime, stopIndex) => {
      const nearby = originByStop.get(stopTime.stopId);
      if (!nearby) return [];
      const departureSeconds = parseGtfsTimeSeconds(
        stopTime.departureTime || stopTime.arrivalTime,
      );
      if (departureSeconds == null) return [];
      const walkMinutes = walkMinutesFromMeters(nearby.distanceMeters);
      if (arriveBy) {
        if (departureSeconds < serviceTime.seconds - 4 * 60 * 60) return [];
        if (departureSeconds > serviceTime.seconds) return [];
      } else {
        if (departureSeconds < serviceTime.seconds + walkMinutes * 60) return [];
        if (departureSeconds > serviceTime.seconds + 4 * 60 * 60) return [];
      }
      return [{ stopTime, stopIndex, nearby, departureSeconds, walkMinutes }];
    });

    for (const board of boardOptions) {
      const alightOptions = stopTimes.slice(board.stopIndex + 1).flatMap(
        (stopTime, offset) => {
          const nearby = destinationByStop.get(stopTime.stopId);
          if (!nearby) return [];
          const arrivalSeconds = parseGtfsTimeSeconds(
            stopTime.arrivalTime || stopTime.departureTime,
          );
          if (arrivalSeconds == null || arrivalSeconds <= board.departureSeconds) {
            return [];
          }
          return [{
            stopTime,
            stopIndex: board.stopIndex + offset + 1,
            nearby,
            arrivalSeconds,
          }];
        },
      );

      for (const alight of alightOptions) {
        const boardStop = index.stopsById.get(board.stopTime.stopId);
        const alightStop = index.stopsById.get(alight.stopTime.stopId);
        if (!boardStop || !alightStop) continue;

        const walkEndMinutes = walkMinutesFromMeters(alight.nearby.distanceMeters);
        const finalArrivalSeconds = alight.arrivalSeconds + walkEndMinutes * 60;
        if (
          arriveBy &&
          (finalArrivalSeconds > serviceTime.seconds ||
            finalArrivalSeconds < serviceTime.seconds - 4 * 60 * 60)
        ) {
          continue;
        }
        const journeyOriginSeconds = arriveBy
          ? board.departureSeconds - board.walkMinutes * 60
          : serviceTime.seconds;
        const route = normalizeRouteShortName(routeName);
        const fallbackTransitPath = stopTimes
          .slice(board.stopIndex, alight.stopIndex + 1)
          .flatMap((stopTime): JourneyCoordinate[] => {
            const stop = index.stopsById.get(stopTime.stopId);
            return stop ? [[stop.lat, stop.lng]] : [];
          });
        const fullTripShape = index.shapesById.get(trip.shapeId);
        const transitPath = sliceTripShape(
          fullTripShape,
          [boardStop.lat, boardStop.lng],
          [alightStop.lat, alightStop.lng],
          fallbackTransitPath,
        );
        const boardShapeIndex = fullTripShape
          ? nearestShapeIndex(fullTripShape, [boardStop.lat, boardStop.lng])
          : -1;
        const approachPath =
          fullTripShape && boardShapeIndex > 0
            ? fullTripShape.slice(0, boardShapeIndex + 1)
            : undefined;
        const nextStop = stopTimes[board.stopIndex + 1];
        const nextStopName = nextStop
          ? index.stopsById.get(nextStop.stopId)?.name
          : undefined;
        const rideStopSequence = stopTimes
          .slice(board.stopIndex, alight.stopIndex + 1)
          .flatMap((stopTime) => {
            const stop = index.stopsById.get(stopTime.stopId);
            const stopSeconds = parseGtfsTimeSeconds(
              stopTime.arrivalTime || stopTime.departureTime,
            );
            return stop && stopSeconds != null
              ? [{
                  id: stop.id,
                  name: stop.name,
                  detail: "",
                  coordinate: [stop.lat, stop.lng] as JourneyCoordinate,
                  time: formatServiceSeconds(stopSeconds),
                }]
              : [];
          });

        candidates.push({
          arrivalSeconds: finalArrivalSeconds,
          journey: {
            id: `gtfs-${trip.tripId}-${boardStop.id}-${alightStop.id}`,
            tripId: trip.tripId,
            dataSource: "scheduled",
            serviceDate: serviceTime.displayDate,
            travelMinutes: Math.max(
              1,
              Math.ceil((finalArrivalSeconds - journeyOriginSeconds) / 60),
            ),
            walkStartMinutes: board.walkMinutes,
            walkStartDistance: formatWalkingDistance(board.nearby.distanceMeters),
            route,
            routeHeadsign: trip.headsign || `Route ${route}`,
            scheduledTime: formatServiceSeconds(board.departureSeconds),
            rideMinutes: Math.max(
              1,
              Math.ceil((alight.arrivalSeconds - board.departureSeconds) / 60),
            ),
            rideStops: alight.stopIndex - board.stopIndex,
            transfers: 0,
            walkEndMinutes,
            walkEndDistance: formatWalkingDistance(alight.nearby.distanceMeters),
            origin: {
              name: origin.name,
              detail: origin.detail,
              coordinate: [origin.lat, origin.lng],
              time: formatServiceSeconds(journeyOriginSeconds),
            },
            boardStop: {
              id: boardStop.id,
              name: boardStop.name,
              detail: `Stop ${boardStop.id}`,
              coordinate: [boardStop.lat, boardStop.lng],
              time: formatServiceSeconds(board.departureSeconds),
            },
            alightStop: {
              id: alightStop.id,
              name: alightStop.name,
              detail: `Stop ${alightStop.id}`,
              coordinate: [alightStop.lat, alightStop.lng],
              time: formatServiceSeconds(alight.arrivalSeconds),
            },
            rideStopSequence,
            destination: {
              name: destination.name,
              detail: destination.detail,
              coordinate: [destination.lat, destination.lng],
              time: formatServiceSeconds(finalArrivalSeconds),
            },
            walkingInstructions: [
              `Head toward ${boardStop.name}.`,
              `Continue for approximately ${formatWalkingDistance(board.nearby.distanceMeters)} until you reach the stop.`,
              `Board Route ${route} toward ${trip.headsign || `Route ${route}`}.`,
            ],
            nextTransitStop: nextStopName ?? alightStop.name,
            path: {
              walkStart: [
                [origin.lat, origin.lng],
                [boardStop.lat, boardStop.lng],
              ],
              approach: approachPath,
              transit: transitPath,
              walkEnd: [
                [alightStop.lat, alightStop.lng],
                [destination.lat, destination.lng],
              ],
            },
            simulation: {
              walkingPosition: [origin.lat, origin.lng],
              transitPosition: [boardStop.lat, boardStop.lng],
              transitPathIndex: 0,
            },
          },
        });
      }
    }
  }

  candidates.sort(
    (first, second) =>
      (arriveBy
        ? second.arrivalSeconds - first.arrivalSeconds
        : first.arrivalSeconds - second.arrivalSeconds) ||
      first.journey.walkStartMinutes - second.journey.walkStartMinutes,
  );
  const selected: JourneyOption[] = [];
  const selectedRoutes = new Set<string>();
  for (const candidate of candidates) {
    if (selectedRoutes.has(candidate.journey.route)) continue;
    selected.push(candidate.journey);
    selectedRoutes.add(candidate.journey.route);
    if (selected.length >= limit) break;
  }

  return {
    journeys: selected,
    origin: {
      name: origin.name,
      detail: origin.detail,
      coordinate: [origin.lat, origin.lng],
    },
    destination: {
      name: destination.name,
      detail: destination.detail,
      coordinate: [destination.lat, destination.lng],
    },
    dataSource: "scheduled",
    fetchedAt: new Date().toISOString(),
  };
}

export async function getGtfsRouteSchedule({
  route,
  destination,
}: {
  route: string;
  destination: string;
}): Promise<{
  route: string;
  name: string;
  headsign: string;
  origin: string;
  destination: string;
  serviceDate: string;
  tripId: string;
  path: Array<[number, number]>;
  stops: Array<StopLocation & { sequence: number; scheduledTime: string }>;
} | null> {
  const index = await getGtfsIndex();
  const routeKey = route.trim().toLocaleUpperCase();
  const routeIds = new Set(index.routeIdsByShortName.get(routeKey) ?? []);
  if (routeIds.size === 0) return null;

  const serviceTime = getHonoluluServiceTime();
  const destinationKey = normalizeSearch(destination);
  const candidates = index.trips.flatMap((trip) => {
    if (
      !routeIds.has(trip.routeId) ||
      !normalizeSearch(trip.headsign).includes(destinationKey) ||
      !isServiceActive(
        index,
        trip.serviceId,
        serviceTime.dateKey,
        serviceTime.weekday,
      )
    ) {
      return [];
    }

    const stopTimes = index.tripStopTimes.get(trip.tripId);
    const firstTime = stopTimes?.[0]?.departureTime || stopTimes?.[0]?.arrivalTime;
    const firstSeconds = firstTime ? parseGtfsTimeSeconds(firstTime) : null;
    if (!stopTimes?.length || firstSeconds == null) return [];
    return [{ trip, stopTimes, firstSeconds }];
  });

  if (candidates.length === 0) return null;
  const futureCandidates = candidates
    .filter((candidate) => candidate.firstSeconds >= serviceTime.seconds)
    .sort((a, b) => a.firstSeconds - b.firstSeconds);
  const selected =
    futureCandidates[0] ??
    candidates.sort((a, b) => b.firstSeconds - a.firstSeconds)[0];

  const stops = selected.stopTimes.flatMap((stopTime) => {
    const stop = index.stopsById.get(stopTime.stopId);
    if (!stop) return [];
    return [
      {
        id: stop.id,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        kind: stop.kind,
        sequence: stopTime.sequence,
        scheduledTime: formatGtfsTime(
          stopTime.arrivalTime || stopTime.departureTime,
        ),
      },
    ];
  });
  if (stops.length < 2) return null;

  const path = index.shapesById.get(selected.trip.shapeId) ??
    stops.map((stop): [number, number] => [stop.lat, stop.lng]);

  return {
    route: routeKey,
    name: `${routeKey} - Hawaiʻi Kai`,
    headsign: selected.trip.headsign,
    origin: stops[0].name,
    destination: stops.at(-1)?.name ?? selected.trip.headsign,
    serviceDate: serviceTime.displayDate,
    tripId: selected.trip.tripId,
    path,
    stops,
  };
}

function distanceSquared(
  point: VehicleLocation,
  stop: Pick<StopLocation, "lat" | "lng">,
): number {
  const lat = point.lat - stop.lat;
  const lng = point.lng - stop.lng;
  return lat * lat + lng * lng;
}

export async function getGtfsTrackingRoute({
  tripId,
  destinationStopId,
  vehicleLocation,
}: {
  tripId: string;
  destinationStopId: string;
  vehicleLocation: VehicleLocation;
}): Promise<{ routeStops: TrackingRouteStop[]; stopsAway: number } | null> {
  const index = await getGtfsIndex();
  const stopIds = index.tripStopIds.get(tripId);
  if (!stopIds) return null;

  const destinationIndex = stopIds.findIndex((stopId) => stopId === destinationStopId);
  if (destinationIndex < 0) return null;

  let currentIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let stopIndex = 0; stopIndex <= destinationIndex; stopIndex += 1) {
    const stop = index.stopsById.get(stopIds[stopIndex]);
    if (!stop) continue;
    const distance = distanceSquared(vehicleLocation, stop);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      currentIndex = stopIndex;
    }
  }

  const firstUpcomingIndex =
    currentIndex === destinationIndex ? destinationIndex : currentIndex + 1;
  const upcomingStopIds = stopIds.slice(firstUpcomingIndex);
  const routeStops = upcomingStopIds.flatMap(
    (stopId, offset): TrackingRouteStop[] => {
      const stop = index.stopsById.get(stopId);
      if (!stop) return [];
      const sequence = firstUpcomingIndex + offset;
      return [
        {
          id: stop.id,
          name: stop.name,
          lat: stop.lat,
          lng: stop.lng,
          kind: stop.kind,
          markerKind:
            sequence === destinationIndex ? "destination" : "intermediate",
          sequence,
        },
      ];
    },
  );

  return {
    routeStops,
    stopsAway: Math.max(0, destinationIndex - currentIndex),
  };
}
