import { createClient } from '@supabase/supabase-js';

function getSupabase(serviceRole = false) {
  const url = process.env.SUPABASE_URL;
  const key = serviceRole ? process.env.SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase not configured');
  return createClient(url, key);
}

function getToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

async function findExistingTrip(adminSupabase, userId, { destination, destination_id, departure, departure_id, style, days, budget, title }) {
  let query = adminSupabase
    .from('saved_trips')
    .select('*')
    .eq('user_id', userId)
    .eq('destination', destination)
    .eq('style', style || null)
    .eq('days', days || null)
    .eq('budget', budget || null)
    .eq('title', title)
    .order('updated_at', { ascending: false })
    .limit(1);

  query = destination_id ? query.eq('destination_id', destination_id) : query.is('destination_id', null);
  query = departure ? query.eq('departure', departure) : query.is('departure', null);
  query = departure_id ? query.eq('departure_id', departure_id) : query.is('departure_id', null);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ===== GET /api/trips?share_id=xxx — Public shared trip (no auth) =====
  if (req.method === 'GET' && req.query.share_id) {
    const adminSupabase = getSupabase(true);
    const { data, error } = await adminSupabase
      .from('saved_trips')
      .select('id, destination, departure, style, days, budget, itinerary, title, share_id, created_at')
      .eq('share_id', req.query.share_id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Trip not found' });
    return res.status(200).json({ trip: data });
  }

  // ===== Auth required below =====
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const supabase = getSupabase();
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  const adminSupabase = getSupabase(true);

  // ===== GET /api/trips — List user's saved trips =====
  if (req.method === 'GET') {
    const { data, error } = await adminSupabase
      .from('saved_trips')
      .select('id, destination, destination_id, departure, departure_id, style, days, budget, title, share_id, created_at, updated_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ trips: data });
  }

  // ===== POST /api/trips — Save a new trip =====
  if (req.method === 'POST') {
    const { destination, destination_id, departure, departure_id, style, days, budget, itinerary, title } = req.body;
    if (!destination || !itinerary) {
      return res.status(400).json({ error: 'Missing required fields (destination, itinerary)' });
    }

    const existingTrip = await findExistingTrip(adminSupabase, user.id, {
      destination,
      destination_id,
      departure,
      departure_id,
      style,
      days,
      budget,
      title: title || `${departure || ''} → ${destination} ${days}天`
    });

    if (existingTrip) {
      const { data, error } = await adminSupabase
        .from('saved_trips')
        .update({
          itinerary,
          destination_id: destination_id || null,
          departure: departure || null,
          departure_id: departure_id || null,
          style: style || null,
          days: days || null,
          budget: budget || null,
          title: title || existingTrip.title
        })
        .eq('id', existingTrip.id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ trip: data, deduped: true });
    }

    const { data, error } = await adminSupabase
      .from('saved_trips')
      .insert({
        user_id: user.id,
        destination,
        destination_id: destination_id || null,
        departure: departure || null,
        departure_id: departure_id || null,
        style: style || null,
        days: days || null,
        budget: budget || null,
        itinerary,
        title: title || `${departure || ''} → ${destination} ${days}天`
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ trip: data });
  }

  // ===== DELETE /api/trips?id=xxx — Delete a trip =====
  if (req.method === 'DELETE') {
    const tripId = req.query.id;
    if (!tripId) return res.status(400).json({ error: 'Missing trip id' });

    // Verify ownership
    const { data: trip } = await adminSupabase
      .from('saved_trips')
      .select('user_id')
      .eq('id', tripId)
      .single();

    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (trip.user_id !== user.id) return res.status(403).json({ error: 'Not authorized' });

    const { error } = await adminSupabase
      .from('saved_trips')
      .delete()
      .eq('id', tripId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
