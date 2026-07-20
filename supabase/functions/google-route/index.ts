const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ALLOWED_ORIGINS = new Set([
  'https://aetherodie-cmyk.github.io',
  'http://localhost:8000',
  'http://localhost:3000',
  'http://127.0.0.1:8765',
  'http://127.0.0.1:8000',
  'http://127.0.0.1:3000',
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : 'https://aetherodie-cmyk.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function isCoordinate(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function googleTravelMode(mode: string) {
  return ({
    'foot-walking': 'WALK',
    'cycling-regular': 'BICYCLE',
    'driving-car': 'DRIVE',
    transit: 'TRANSIT',
  } as Record<string, string>)[mode];
}

function durationSeconds(value: unknown) {
  const match = String(value || '').match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Math.round(Number(match[1])) : null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) });
  if (request.method !== 'POST') return json(request, { error: '只接受 POST 請求。' }, 405);

  const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!apiKey) return json(request, { error: 'Google Routes API 尚未設定。' }, 503);

  let input: Record<string, any>;
  try {
    input = await request.json();
  } catch {
    return json(request, { error: '請求格式不正確。' }, 400);
  }

  const origin = input.origin || {};
  const destination = input.destination || {};
  const travelMode = googleTravelMode(String(input.mode || ''));
  if (
    !isCoordinate(origin.lat, -90, 90) || !isCoordinate(origin.lng, -180, 180) ||
    !isCoordinate(destination.lat, -90, 90) || !isCoordinate(destination.lng, -180, 180) ||
    !travelMode
  ) {
    return json(request, { error: '起點、終點或交通方式不正確。' }, 400);
  }

  const googleRequest: Record<string, any> = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    travelMode,
    languageCode: 'zh-TW',
    units: 'METRIC',
  };

  const departure = input.departureTime ? new Date(input.departureTime) : null;
  const isFuture = departure && !Number.isNaN(departure.getTime()) && departure.getTime() > Date.now() + 60_000;
  if (isFuture && (travelMode === 'DRIVE' || travelMode === 'TRANSIT')) {
    googleRequest.departureTime = departure.toISOString();
  }
  if (isFuture && travelMode === 'DRIVE') googleRequest.routingPreference = 'TRAFFIC_AWARE';

  try {
    const response = await fetch(GOOGLE_ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify(googleRequest),
    });
    const data = await response.json();
    if (!response.ok) {
      const message = data?.error?.message || `Google Routes API ${response.status}`;
      return json(request, { error: message }, response.status >= 500 ? 502 : 400);
    }

    const route = data?.routes?.[0];
    const durationSec = durationSeconds(route?.duration);
    const distanceM = Number(route?.distanceMeters);
    if (!durationSec || !Number.isFinite(distanceM)) {
      return json(request, { error: 'Google Maps 找不到可用路線。' }, 404);
    }
    return json(request, { durationSec, distanceM, source: 'Google Maps' });
  } catch (error) {
    return json(request, { error: error instanceof Error ? error.message : 'Google 路線服務連線失敗。' }, 502);
  }
});
