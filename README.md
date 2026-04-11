# MAP BOOM!

Comic-style AI travel planner built with React + Vite, deployed on Vercel.

## Current Product Shape

- 3D globe-first trip planner with draggable rotation, zoom, route arcs, marker clustering, and hidden-place shortcuts for destinations on the far side of the globe.
- Bilingual UI with `English` as the default language and a `English / 中文` toggle in the top-right settings menu.
- Destination model supports broad regions plus specific stops:
  - Region level: country, state, or travel area such as `Japan`, `California`, `Australia`, `Peru`
  - Stop level: cities or concrete places under that region such as `Tokyo`, `Sydney`, `Cusco`
- Left panel is intentionally simplified:
  - Always visible: departure, broad region, specific stop
  - Collapsed by default: style, budget, days, passport/visa tuning
  - Summary card shows the current trip brief at a glance

## Data And Persistence

There are two separate storage layers:

1. Redis cache for generated itineraries
- File: [api/generate-itinerary.js](/Users/mac/Desktop/MyTravelApp/frontend/api/generate-itinerary.js)
- Uses Upstash Redis when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are configured
- Cache key includes:
  - destination
  - style
  - days
  - budget
  - departure
  - language
- Successful AI generations are cached for 7 days to reduce repeated DeepSeek calls

2. Supabase for user-saved trips
- Files:
  - [src/lib/supabase.js](/Users/mac/Desktop/MyTravelApp/frontend/src/lib/supabase.js)
  - [api/trips.js](/Users/mac/Desktop/MyTravelApp/frontend/api/trips.js)
- Trips are only written to the `saved_trips` table when the signed-in user clicks `Save trip`
- Saved data includes `destination_id`, `departure_id`, itinerary payload, style, days, budget, and title

Important distinction:
- Generated itinerary reuse: automatic via Redis cache
- User library persistence: manual via `Save trip`
- Destination catalog itself is still hardcoded in [src/App.jsx](/Users/mac/Desktop/MyTravelApp/frontend/src/App.jsx), not in the database

## AI Generation Flow

- Frontend calls `/api/generate-itinerary`
- Backend checks Redis first
- On cache miss, backend calls DeepSeek
- System prompt appends a strict language instruction:
  - `Please generate the itinerary and respond strictly and entirely in ${language}`
- If live generation fails, the app falls back to local static itinerary content

## Main Files

- [src/App.jsx](/Users/mac/Desktop/MyTravelApp/frontend/src/App.jsx)
  - Core UI, map rendering, region/stop data, language switching, itinerary state
- [api/generate-itinerary.js](/Users/mac/Desktop/MyTravelApp/frontend/api/generate-itinerary.js)
  - DeepSeek request + Redis caching
- [api/trips.js](/Users/mac/Desktop/MyTravelApp/frontend/api/trips.js)
  - Saved trip CRUD backed by Supabase
- [src/lib/supabase.js](/Users/mac/Desktop/MyTravelApp/frontend/src/lib/supabase.js)
  - Auth and API helpers
- [src/staticItineraries.json](/Users/mac/Desktop/MyTravelApp/frontend/src/staticItineraries.json)
  - Fallback itinerary source

## Local Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Current build status:
- Production build passes
- Vite still reports a large client chunk warning around the main bundle size

## Deployment

- GitHub: `main` branch
- Hosting: Vercel production deployment
- Current production alias used in this project:
  - `https://frontend-nine-sigma-91.vercel.app`
