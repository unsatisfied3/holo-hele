import { MOCK_ARRIVALS } from "@/lib/mock/nearby";
import {
  findMockArrival,
  getMockRouteStops,
  getMockVehicleLocation,
} from "@/lib/mock/tracking";
import { fetchArrivalTracking, fetchStopArrivals } from "@/lib/thebus/client";
import { getTheBusApiKey, isTheBusApiKeyConfigured } from "@/lib/thebus/config";
import { getStopById } from "@/lib/thebus/stops";
import { estimateStopsAway } from "@/lib/tracking/route-visualization";
import {
  getGtfsNearbyStops,
  getGtfsStops,
  getGtfsTripPlan,
  getGtfsDailyStopSchedule,
  getGtfsRouteSchedule,
  getGtfsStop,
  getGtfsStopSchedule,
  getGtfsTrackingRoute,
  searchGtfsStops,
} from "@/server/gtfs";
import { getServiceAlerts } from "@/server/service-alerts";
import { getWalkingDirections } from "@/server/walking-directions";
import { serveStaticSite } from "@/server/static-site";
import type {
  JourneyCoordinate,
  JourneyOption,
  NearbyStopResult,
  TrackingRouteStop,
  TripPlanResponse,
} from "@/types/transit";

const DEFAULT_LAT = 21.3047;
const DEFAULT_LNG = -157.8567;
const port = Number(Bun.env.PORT ?? Bun.env.API_PORT ?? 3001);
const staticSiteDirectory = Bun.env.STATIC_SITE_DIR;
const defaultOrigins = [
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];
const allowedOrigins = new Set(
  (Bun.env.API_ALLOWED_ORIGINS ?? defaultOrigins.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);
if (Bun.env.RENDER_EXTERNAL_URL) {
  allowedOrigins.add(new URL(Bun.env.RENDER_EXTERNAL_URL).origin);
}

function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    Vary: "Origin",
  };

  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function json(
  body: unknown,
  status = 200,
  origin: string | null = null,
): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders(origin),
  });
}

function parseCoordinate(
  searchParams: URLSearchParams,
  name: "lat" | "lng",
  fallback: number,
): number | null {
  const raw = searchParams.get(name);
  if (raw == null) return fallback;
  const value = Number(raw);
  const limit = name === "lat" ? 90 : 180;
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

async function nearby(url: URL, origin: string | null): Promise<Response> {
  const lat = parseCoordinate(url.searchParams, "lat", DEFAULT_LAT);
  const lng = parseCoordinate(url.searchParams, "lng", DEFAULT_LNG);

  if (lat == null || lng == null) {
    return json({ error: "Latitude or longitude is invalid." }, 400, origin);
  }

  let officialStops: NearbyStopResult[];
  try {
    officialStops = await getGtfsNearbyStops({ lat, lng, limit: 10 });
  } catch {
    return json(
      {
        error:
          "Official nearby stop data is temporarily unavailable. Check your connection and try again.",
      },
      502,
      origin,
    );
  }

  if (!isTheBusApiKeyConfigured()) {
    return json(
      {
        stops: officialStops,
        userLocation: { lat, lng },
        fetchedAt: new Date().toISOString(),
        dataSource: "scheduled" as const,
      },
      200,
      origin,
    );
  }

  const apiKey = getTheBusApiKey();
  if (!apiKey) {
    return json(
      { error: "Transit data is not configured. Set THEBUS_API_KEY on the server." },
      503,
      origin,
    );
  }

  const stops: NearbyStopResult[] = await Promise.all(
    officialStops.map(async (scheduledStop, stopIndex) => {
      if (stopIndex >= 4) return scheduledStop;

      const { arrivals, timestamp, error } = await fetchStopArrivals(
        scheduledStop.stop.id,
        apiKey,
      );
      const displayedArrivals = error ? scheduledStop.arrivals : arrivals;
      return {
        ...scheduledStop,
        lines: scheduledStop.lines,
        arrivals: displayedArrivals,
        nextArrival: displayedArrivals[0],
        dataUpdatedAt: timestamp,
        error,
      };
    }),
  );

  const hasErrors = stops.some((stop) => stop.error);
  return json(
    {
      stops,
      userLocation: { lat, lng },
      fetchedAt: new Date().toISOString(),
      dataSource: "live" as const,
      ...(hasErrors
        ? { error: "Some nearby stops could not be loaded. Arrivals shown may be incomplete." }
        : {}),
    },
    200,
    origin,
  );
}

async function arrivals(url: URL, origin: string | null): Promise<Response> {
  const stop = url.searchParams.get("stop")?.trim();
  if (!stop) return json({ error: "Missing stop parameter." }, 400, origin);

  if (!isTheBusApiKeyConfigured()) {
    try {
      const schedule = await getGtfsStopSchedule(stop);
      if (!schedule) return json({ error: "Stop not found." }, 404, origin);
      return json(
        {
          stop,
          arrivals: schedule.arrivals,
          lines: schedule.lines,
          fetchedAt: new Date().toISOString(),
          dataSource: "scheduled" as const,
        },
        200,
        origin,
      );
    } catch {
      return json(
        { error: "The official stop schedule is temporarily unavailable." },
        502,
        origin,
      );
    }
  }

  const apiKey = getTheBusApiKey();
  if (!apiKey) {
    return json(
      {
        stop,
        error: "Transit data is not configured. Set THEBUS_API_KEY on the server.",
      },
      503,
      origin,
    );
  }

  const result = await fetchStopArrivals(stop, apiKey);
  if (result.error) {
    return json(
      {
        stop,
        arrivals: [],
        lines: [],
        fetchedAt: new Date().toISOString(),
        dataSource: "live" as const,
        error: result.error,
      },
      502,
      origin,
    );
  }

  return json(
    {
      stop,
      arrivals: result.arrivals,
      lines: [...new Set(result.arrivals.map((arrival) => arrival.route))],
      fetchedAt: result.timestamp ?? new Date().toISOString(),
      dataSource: "live" as const,
    },
    200,
    origin,
  );
}

async function tracking(url: URL, origin: string | null): Promise<Response> {
  const stopId = url.searchParams.get("stop")?.trim();
  const arrivalId = url.searchParams.get("arrival")?.trim();
  if (!stopId || !arrivalId) {
    return json({ error: "Missing stop or arrival parameter." }, 400, origin);
  }

  const stop = getStopById(stopId) ?? (await getGtfsStop(stopId));
  if (!stop) return json({ error: "Stop not found." }, 404, origin);

  if (!isTheBusApiKeyConfigured()) {
    const arrival = findMockArrival(stopId, arrivalId, MOCK_ARRIVALS);
    if (!arrival) {
      return json(
        { error: "This bus is no longer listed at this stop." },
        404,
        origin,
      );
    }

    const stopsAway = estimateStopsAway(arrival);

    return json(
      {
        stop: stopId,
        arrival,
        vehicleLocation: getMockVehicleLocation(stop, arrival),
        stopsAway,
        stopsAwaySource:
          stopsAway == null ? ("unavailable" as const) : ("estimated" as const),
        routeStops: getMockRouteStops(stop, stopsAway),
        fetchedAt: new Date().toISOString(),
        dataSource: "mock" as const,
      },
      200,
      origin,
    );
  }

  const apiKey = getTheBusApiKey();
  if (!apiKey) {
    return json(
      {
        error: "Transit data is not configured. Set THEBUS_API_KEY on the server.",
        stop: stopId,
      },
      503,
      origin,
    );
  }

  const result = await fetchArrivalTracking(stopId, arrivalId, apiKey);
  if (result.error && !result.arrival) {
    return json(
      {
        stop: stopId,
        error: result.error,
        fetchedAt: new Date().toISOString(),
        dataSource: "live" as const,
      },
      result.error.includes("no longer listed") ? 404 : 502,
      origin,
    );
  }

  if (!result.arrival) {
    return json(
      { error: "This bus is no longer listed at this stop." },
      404,
      origin,
    );
  }

  let routeStops: TrackingRouteStop[] = [];
  let stopsAway = estimateStopsAway(result.arrival);
  let stopsAwaySource: "exact" | "estimated" | "unavailable" =
    stopsAway == null ? "unavailable" : "estimated";

  if (result.arrival.trip && result.vehicleLocation) {
    try {
      const gtfsRoute = await getGtfsTrackingRoute({
        tripId: result.arrival.trip,
        destinationStopId: stopId,
        vehicleLocation: result.vehicleLocation,
      });
      if (gtfsRoute) {
        routeStops = gtfsRoute.routeStops;
        stopsAway = gtfsRoute.stopsAway;
        stopsAwaySource = "exact";
      }
    } catch {
      // Keep the estimated count, but never invent named live route stops.
    }
  }

  return json(
    {
      stop: stopId,
      arrival: result.arrival,
      vehicleLocation: result.vehicleLocation,
      stopsAway,
      stopsAwaySource,
      routeStops,
      fetchedAt: result.timestamp ?? new Date().toISOString(),
      dataSource: "live" as const,
      error: result.error,
    },
    200,
    origin,
  );
}

function nearestJourneyPathIndex(
  path: JourneyCoordinate[],
  coordinate: JourneyCoordinate,
): number {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  path.forEach(([lat, lng], index) => {
    const distance = (lat - coordinate[0]) ** 2 + (lng - coordinate[1]) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function shiftDisplayTime(time: string, minutesToAdd: number): string {
  const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return time;
  let hours = Number(match[1]) % 12;
  const minutes = Number(match[2]);
  if (match[3].toLocaleUpperCase() === "PM") hours += 12;
  const shifted = (hours * 60 + minutes + minutesToAdd + 24 * 60) % (24 * 60);
  const shiftedHour = Math.floor(shifted / 60);
  const suffix = shiftedHour >= 12 ? "PM" : "AM";
  return `${shiftedHour % 12 || 12}:${String(shifted % 60).padStart(2, "0")} ${suffix}`;
}

function enrichPlannedJourney(
  journey: JourneyOption,
  result: Awaited<ReturnType<typeof fetchStopArrivals>>,
): { journey: JourneyOption; failed: boolean } {
  if (result.error) return { journey, failed: true };
  const liveArrival = result.arrivals.find(
    (arrival) =>
      arrival.estimated &&
      arrival.trip != null &&
      arrival.trip === journey.tripId,
  );
  if (!liveArrival) return { journey, failed: false };
  const etaMinutes = liveArrival.minutesUntil;
  if (etaMinutes == null || etaMinutes < journey.walkStartMinutes) {
    return { journey, failed: false };
  }

  const vehiclePosition =
    liveArrival.latitude != null && liveArrival.longitude != null
      ? ([liveArrival.latitude, liveArrival.longitude] as JourneyCoordinate)
      : journey.simulation.transitPosition;
  const approachPath = journey.path.approach;
  const approachIndex = approachPath?.length
    ? nearestJourneyPathIndex(approachPath, vehiclePosition)
    : 0;
  const scheduledWaitMinutes = Math.max(
    journey.walkStartMinutes,
    journey.travelMinutes - journey.rideMinutes - journey.walkEndMinutes,
  );
  const delayMinutes = etaMinutes - scheduledWaitMinutes;

  return {
    failed: false,
    journey: {
      ...journey,
      dataSource: "live",
      etaMinutes,
      scheduleDeviationMinutes: delayMinutes,
      travelMinutes: etaMinutes + journey.rideMinutes + journey.walkEndMinutes,
      boardStop: {
        ...journey.boardStop,
        time: liveArrival.stopTime || journey.boardStop.time,
      },
      alightStop: {
        ...journey.alightStop,
        time: shiftDisplayTime(journey.alightStop.time, delayMinutes),
      },
      destination: {
        ...journey.destination,
        time: shiftDisplayTime(journey.destination.time, delayMinutes),
      },
      path: {
        ...journey.path,
        approach: approachPath?.length
          ? [vehiclePosition, ...approachPath.slice(approachIndex + 1)]
          : undefined,
      },
      simulation: {
        ...journey.simulation,
        transitPosition: vehiclePosition,
        transitPathIndex: nearestJourneyPathIndex(
          journey.path.transit,
          vehiclePosition,
        ),
      },
    },
  };
}

async function tripPlan(url: URL, origin: string | null): Promise<Response> {
  const originLat = parseCoordinate(url.searchParams, "lat", Number.NaN);
  const originLng = parseCoordinate(url.searchParams, "lng", Number.NaN);
  const destinationLatRaw = url.searchParams.get("destinationLat");
  const destinationLngRaw = url.searchParams.get("destinationLng");
  const destinationLat = destinationLatRaw?.trim()
    ? Number(destinationLatRaw)
    : Number.NaN;
  const destinationLng = destinationLngRaw?.trim()
    ? Number(destinationLngRaw)
    : Number.NaN;
  const destinationName = url.searchParams.get("destination")?.trim();
  const destinationDetail = url.searchParams.get("destinationDetail")?.trim() ?? "";
  const originName = url.searchParams.get("origin")?.trim() || "Current location";
  const departureOffsetMinutes = Number(
    url.searchParams.get("departureOffsetMinutes") ?? "0",
  );
  const timeModeRaw = url.searchParams.get("timeMode") ?? "now";
  const timeMode =
    timeModeRaw === "leave" || timeModeRaw === "arrive" ? timeModeRaw : "now";
  const requestedTimeRaw = url.searchParams.get("requestedTime");
  const requestedTime = requestedTimeRaw ? new Date(requestedTimeRaw) : null;

  if (
    originLat == null ||
    originLng == null ||
    !Number.isFinite(originLat) ||
    !Number.isFinite(originLng) ||
    !Number.isFinite(destinationLat) ||
    Math.abs(destinationLat) > 90 ||
    !Number.isFinite(destinationLng) ||
    Math.abs(destinationLng) > 180 ||
    !destinationName ||
    !Number.isFinite(departureOffsetMinutes) ||
    departureOffsetMinutes < 0 ||
    departureOffsetMinutes > 240 ||
    !["now", "leave", "arrive"].includes(timeModeRaw) ||
    (timeMode !== "now" &&
      (!requestedTime || !Number.isFinite(requestedTime.getTime())))
  ) {
    return json({ error: "Trip origin or destination is invalid." }, 400, origin);
  }

  let scheduledPlan: TripPlanResponse;
  try {
    const planningTime =
      timeMode === "now"
        ? new Date(Date.now() + departureOffsetMinutes * 60_000)
        : (requestedTime as Date);
    scheduledPlan = await getGtfsTripPlan({
      origin: {
        name: originName,
        detail: "Approximate device location",
        lat: originLat,
        lng: originLng,
      },
      destination: {
        name: destinationName,
        detail: destinationDetail,
        lat: destinationLat,
        lng: destinationLng,
      },
      planningTime,
      arriveBy: timeMode === "arrive",
    });
  } catch {
    return json(
      { error: "Official trip-planning data is temporarily unavailable." },
      502,
      origin,
    );
  }

  const apiKey = getTheBusApiKey();
  if (
    !apiKey ||
    scheduledPlan.journeys.length === 0 ||
    departureOffsetMinutes > 0 ||
    timeMode !== "now"
  ) {
    return json(scheduledPlan, 200, origin);
  }

  const boardingStopIds = [
    ...new Set(scheduledPlan.journeys.map((journey) => journey.boardStop.id)),
  ];
  const liveResults = new Map(
    await Promise.all(
      boardingStopIds.map(async (stopId) => [
        stopId,
        await fetchStopArrivals(stopId, apiKey),
      ] as const),
    ),
  );
  const enriched = scheduledPlan.journeys.map((journey) =>
    enrichPlannedJourney(
      journey,
      liveResults.get(journey.boardStop.id) ?? {
        arrivals: [],
        error: "Live estimates are unavailable.",
      },
    ),
  );
  const journeys = enriched
    .map((result) => result.journey)
    .sort(
      (first, second) =>
        first.travelMinutes - second.travelMinutes ||
        first.walkStartMinutes - second.walkStartMinutes,
    );
  const hasLiveJourney = journeys.some((journey) => journey.dataSource === "live");
  const liveFailed = enriched.some((result) => result.failed);

  return json(
    {
      ...scheduledPlan,
      journeys,
      dataSource: hasLiveJourney ? ("live" as const) : ("scheduled" as const),
      ...(liveFailed
        ? { error: "Some live estimates are unavailable. Scheduled times are shown." }
        : {}),
    },
    200,
    origin,
  );
}

function walkingCoordinate(
  searchParams: URLSearchParams,
  name: string,
  limit: number,
) {
  const value = Number(searchParams.get(name));
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

async function walkingDirections(
  url: URL,
  origin: string | null,
): Promise<Response> {
  const originLat = walkingCoordinate(url.searchParams, "originLat", 90);
  const originLng = walkingCoordinate(url.searchParams, "originLng", 180);
  const boardLat = walkingCoordinate(url.searchParams, "boardLat", 90);
  const boardLng = walkingCoordinate(url.searchParams, "boardLng", 180);
  const alightLat = walkingCoordinate(url.searchParams, "alightLat", 90);
  const alightLng = walkingCoordinate(url.searchParams, "alightLng", 180);
  const destinationLat = walkingCoordinate(
    url.searchParams,
    "destinationLat",
    90,
  );
  const destinationLng = walkingCoordinate(
    url.searchParams,
    "destinationLng",
    180,
  );

  if (
    originLat == null ||
    originLng == null ||
    boardLat == null ||
    boardLng == null ||
    alightLat == null ||
    alightLng == null ||
    destinationLat == null ||
    destinationLng == null
  ) {
    return json({ error: "Walking route coordinates are invalid." }, 400, origin);
  }

  return json(
    await getWalkingDirections({
      origin: [originLat, originLng],
      board: [boardLat, boardLng],
      alight: [alightLat, alightLng],
      destination: [destinationLat, destinationLng],
    }),
    200,
    origin,
  );
}

async function mapStops(origin: string | null): Promise<Response> {
  try {
    return json(
      {
        stops: await getGtfsStops(),
        fetchedAt: new Date().toISOString(),
        dataSource: "scheduled" as const,
      },
      200,
      origin,
    );
  } catch {
    return json(
      { error: "Official island-wide stop data is temporarily unavailable." },
      502,
      origin,
    );
  }
}

async function searchStops(url: URL, origin: string | null): Promise<Response> {
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (!query) return json({ error: "Missing search query." }, 400, origin);
  if (query.length > 80) {
    return json({ error: "Search query is too long." }, 400, origin);
  }

  try {
    return json(
      {
        stops: await searchGtfsStops(query),
        fetchedAt: new Date().toISOString(),
        dataSource: "scheduled" as const,
      },
      200,
      origin,
    );
  } catch {
    return json(
      { error: "Official stop search is temporarily unavailable." },
      502,
      origin,
    );
  }
}

async function routeSchedule(url: URL, origin: string | null): Promise<Response> {
  const route = url.searchParams.get("route")?.trim();
  const destination = url.searchParams.get("destination")?.trim();
  if (!route || !destination) {
    return json({ error: "Missing route or destination parameter." }, 400, origin);
  }

  try {
    const schedule = await getGtfsRouteSchedule({ route, destination });
    if (!schedule) {
      return json(
        { error: "No active trip was found for this route and direction." },
        404,
        origin,
      );
    }

    return json(
      {
        ...schedule,
        dataSource: "scheduled" as const,
        fetchedAt: new Date().toISOString(),
      },
      200,
      origin,
    );
  } catch {
    return json(
      {
        error:
          "The official route schedule is temporarily unavailable. Try again shortly.",
      },
      502,
      origin,
    );
  }
}

async function dailyStopSchedule(
  url: URL,
  origin: string | null,
): Promise<Response> {
  const stop = url.searchParams.get("stop")?.trim();
  const route = url.searchParams.get("route")?.trim();
  const dayParam = url.searchParams.get("day")?.trim();
  const dateParam = url.searchParams.get("date")?.trim();
  if (!stop) return json({ error: "Missing stop parameter." }, 400, origin);
  if (dayParam && dayParam !== "today" && dayParam !== "tomorrow") {
    return json({ error: "Invalid day parameter." }, 400, origin);
  }
  if (dateParam && !isValidIsoDate(dateParam)) {
    return json({ error: "Invalid date parameter." }, 400, origin);
  }
  const serviceDate = dateParam ?? (dayParam === "tomorrow" ? "tomorrow" : "today");

  try {
    const schedule = await getGtfsDailyStopSchedule(stop, route, serviceDate);
    if (!schedule) return json({ error: "Stop not found." }, 404, origin);
    return json(
      {
        ...schedule,
        dataSource: "scheduled" as const,
        fetchedAt: new Date().toISOString(),
      },
      200,
      origin,
    );
  } catch {
    return json(
      { error: "The official daily schedule is temporarily unavailable." },
      502,
      origin,
    );
  }
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

async function stopLocation(url: URL, origin: string | null): Promise<Response> {
  const stopId = url.searchParams.get("stop")?.trim();
  if (!stopId) return json({ error: "Missing stop parameter." }, 400, origin);

  try {
    const stop = await getGtfsStop(stopId);
    return stop
      ? json({ stop }, 200, origin)
      : json({ error: "Stop not found." }, 404, origin);
  } catch {
    return json(
      { error: "Official stop information is temporarily unavailable." },
      502,
      origin,
    );
  }
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (origin && !allowedOrigins.has(origin)) {
      return json({ error: "Origin is not allowed." }, 403, origin);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (staticSiteDirectory && !isApi && url.pathname !== "/health" &&
      (request.method === "GET" || request.method === "HEAD")) {
      return serveStaticSite(request, staticSiteDirectory);
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed." }, 405, origin);
    }

    if (url.pathname === "/health") {
      return json({ status: "ok" }, 200, origin);
    }
    if (url.pathname === "/api/nearby") return nearby(url, origin);
    if (url.pathname === "/api/stops") return mapStops(origin);
    if (url.pathname === "/api/search-stops") return searchStops(url, origin);
    if (url.pathname === "/api/stop") return stopLocation(url, origin);
    if (url.pathname === "/api/arrivals") return arrivals(url, origin);
    if (url.pathname === "/api/tracking") return tracking(url, origin);
    if (url.pathname === "/api/trip-plan") return tripPlan(url, origin);
    if (url.pathname === "/api/walking-directions") {
      return walkingDirections(url, origin);
    }
    if (url.pathname === "/api/route-schedule") {
      return routeSchedule(url, origin);
    }
    if (url.pathname === "/api/daily-schedule") {
      return dailyStopSchedule(url, origin);
    }
    if (url.pathname === "/api/alerts") {
      return json(await getServiceAlerts(), 200, origin);
    }
    return json({ error: "Not found." }, 404, origin);
  },
});

console.info(`Holo Hele API listening on http://127.0.0.1:${server.port}`);
