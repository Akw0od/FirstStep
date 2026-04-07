import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://xjdoucfujlgsynhhhevw.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqZG91Y2Z1amxnc3luaGhoZXZ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU0NTEzOTEsImV4cCI6MjA5MTAyNzM5MX0.YG-TLPgxvn9_5FKE65QPolExZ3PLCreZ4kVRFYQIvLY';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== Auth Helpers =====
export async function signInWithGitHub() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: window.location.origin
    }
  });
  if (error) throw error;
  return data;
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: {
        access_type: 'offline',
        prompt: 'consent'
      }
    }
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export function onAuthStateChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
}

// ===== API Helpers (use Vercel serverless for backend logic) =====
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

async function apiCall(path, options = {}) {
  const session = await getSession();
  const headers = { 'Content-Type': 'application/json' };
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export async function saveTrip({ destination, destination_id, departure, departure_id, style, days, budget, itinerary, title }) {
  return apiCall('/api/trips', {
    method: 'POST',
    body: JSON.stringify({ destination, destination_id, departure, departure_id, style, days, budget, itinerary, title })
  });
}

export async function getMyTrips() {
  return apiCall('/api/trips');
}

export async function deleteTrip(id) {
  return apiCall(`/api/trips?id=${id}`, { method: 'DELETE' });
}

export async function getSharedTrip(shareId) {
  const res = await fetch(`${API_BASE}/api/trips?share_id=${shareId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Trip not found');
  return data;
}
