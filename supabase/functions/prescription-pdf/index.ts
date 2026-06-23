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

function buildPdfToken(secret: string, prescriptionId: string, clinicId: string, expiresAt: string) {
  return hmacSha256Hex(secret, `pdf:${prescriptionId}:${clinicId}:${expiresAt}`).then((hex) => hex.slice(0, 32));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  try {
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
  const clinicId = clean(url.searchParams.get('c'), 80);
  const expiresAt = clean(url.searchParams.get('exp'), 40);
  const token = clean(url.searchParams.get('t'), 80);

  if (!/^[0-9a-f-]{36}$/i.test(prescriptionId) || !/^[0-9a-f-]{36}$/i.test(clinicId) || !/^\d{10,13}$/.test(expiresAt) || !/^[a-f0-9]{32}$/i.test(token)) {
    return new Response('Invalid prescription link', { status: 400 });
  }

  if (Number(expiresAt) < Math.floor(Date.now() / 1000)) {
    return new Response('Prescription link expired', { status: 403 });
  }

  const expected = (await buildPdfToken(internalSecret, prescriptionId, clinicId, expiresAt)).slice(0, 32);
  if (!timingSafeEqual(token.toLowerCase(), expected.toLowerCase())) {
    return new Response('Invalid or expired prescription link', { status: 403 });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: prescription, error } = await admin
    .from('prescriptions')
    .select('pdf_storage_path, status')
    .eq('id', prescriptionId)
    .eq('clinic_id', clinicId)
    .single();

  if (error || !prescription?.pdf_storage_path || prescription.status !== 'issued') {
    return new Response('Prescription PDF not found', { status: 404 });
  }

  const storagePath = String(prescription.pdf_storage_path || '').replace(/^\/+/, '');
  if (!storagePath || storagePath.includes('..')) {
    return new Response('Prescription PDF not available', { status: 404 });
  }

  const { data: signed, error: signedError } = await admin
    .storage
    .from('prescriptions')
    .createSignedUrl(storagePath, 60 * 10);

  if (signedError || !signed?.signedUrl || !/^https:\/\//i.test(String(signed.signedUrl))) {
    return new Response('Prescription PDF not available', { status: 404 });
  }

  return Response.redirect(signed.signedUrl, 302);
  } catch (err) {
    console.error('prescription-pdf unexpected error:', err instanceof Error ? err.message : String(err));
    return new Response('Prescription link error', { status: 500 });
  }
});
