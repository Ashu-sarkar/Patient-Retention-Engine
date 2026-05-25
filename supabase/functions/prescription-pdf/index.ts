import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

function clean(value: unknown, max = 200) {
  return String(value || '').trim().slice(0, max);
}

async function hmacSha256Hex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function buildPdfToken(secret: string, prescriptionId: string) {
  return hmacSha256Hex(secret, `pdf:${prescriptionId}`).then((hex) => hex.slice(0, 32));
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const internalSecret = Deno.env.get('INTERNAL_WEBHOOK_SECRET') || '';

  if (!supabaseUrl || !serviceKey || !internalSecret) {
    return new Response('PDF gateway not configured', { status: 500 });
  }

  const url = new URL(req.url);
  const prescriptionId = clean(url.searchParams.get('id'), 80);
  const token = clean(url.searchParams.get('t'), 80);

  if (!/^[0-9a-f-]{36}$/i.test(prescriptionId) || !/^[a-f0-9]{32}$/i.test(token)) {
    return new Response('Invalid prescription link', { status: 400 });
  }

  const expected = (await buildPdfToken(internalSecret, prescriptionId)).slice(0, 32);
  if (token !== expected) {
    return new Response('Invalid or expired prescription link', { status: 403 });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: prescription, error } = await admin
    .from('prescriptions')
    .select('pdf_url, status')
    .eq('id', prescriptionId)
    .single();

  if (error || !prescription?.pdf_url || prescription.status !== 'issued') {
    return new Response('Prescription PDF not found', { status: 404 });
  }

  return Response.redirect(prescription.pdf_url, 302);
});
