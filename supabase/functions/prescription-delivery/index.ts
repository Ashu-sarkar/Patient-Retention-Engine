import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type Medicine = {
  medicine_name?: string;
  generic_name?: string | null;
  dosage?: string;
  frequency?: string;
  timing?: string;
  duration?: string;
  instructions?: string | null;
  sort_order?: number;
};

const _allowedOrigin = Deno.env.get('DOCTOR_DASHBOARD_ORIGIN') || '';
const corsHeaders: Record<string, string> = {
  ...(_allowedOrigin ? { 'Access-Control-Allow-Origin': _allowedOrigin } : {}),
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function clean(value: unknown, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key])}`)
    .join(',')}}`;
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const n8nUrl = Deno.env.get('N8N_PRESCRIPTION_DELIVERY_URL') || '';
  const internalSecret = Deno.env.get('INTERNAL_WEBHOOK_SECRET') || '';

  if (!supabaseUrl || !supabaseAnonKey || !n8nUrl || !internalSecret) {
    return jsonResponse(500, { error: 'Prescription delivery gateway is not configured' });
  }

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Authentication required' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const prescriptionId = clean(body.prescription_id, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(prescriptionId)) {
    return jsonResponse(400, { error: 'prescription_id must be a UUID' });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return jsonResponse(401, { error: 'Invalid doctor session' });

  const { data: prescription, error: prescriptionError } = await supabase
    .from('prescriptions')
    .select(`
      id,
      status,
      patient_id,
      visit_id,
      doctor_profile_id,
      delivery_status,
      pdf_url,
      pdf_storage_path,
      doctor_snapshot,
      clinic_snapshot,
      patient:patients(id, name, phone),
      medicines:prescription_medicines(
        medicine_name,
        generic_name,
        dosage,
        frequency,
        timing,
        duration,
        instructions,
        sort_order
      )
    `)
    .eq('id', prescriptionId)
    .single();

  if (prescriptionError || !prescription) {
    return jsonResponse(404, { error: 'Prescription not found or not accessible' });
  }

  if (prescription.status !== 'issued') {
    return jsonResponse(409, { error: 'Only issued prescriptions can be delivered' });
  }

  if (prescription.delivery_status === 'sent') {
    return jsonResponse(409, { error: 'Prescription was already sent' });
  }

  const patient = Array.isArray(prescription.patient)
    ? prescription.patient[0]
    : prescription.patient;
  const phone = clean(patient?.phone, 20);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return jsonResponse(422, { error: 'Patient phone is missing or invalid' });
  }

  const pdfUrl = clean(prescription.pdf_url, 3000);
  if (!/^https:\/\//i.test(pdfUrl)) {
    return jsonResponse(422, { error: 'Prescription PDF URL must be an HTTPS signed URL' });
  }

  const doctor = prescription.doctor_snapshot || {};
  const clinic = prescription.clinic_snapshot || {};
  const medicines = (Array.isArray(prescription.medicines) ? prescription.medicines : [])
    .sort((a: Medicine, b: Medicine) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
    .map((medicine: Medicine) => ({
      medicine_name: clean(medicine.medicine_name, 180),
      generic_name: medicine.generic_name ? clean(medicine.generic_name, 180) : null,
      dosage: clean(medicine.dosage, 80),
      frequency: clean(medicine.frequency, 80),
      timing: clean(medicine.timing, 80),
      duration: clean(medicine.duration, 80),
      instructions: medicine.instructions ? clean(medicine.instructions, 500) : null,
    }));

  const payload = {
    prescription_id: prescription.id,
    patient_id: prescription.patient_id,
    visit_id: prescription.visit_id,
    patient_name: clean(patient?.name, 180) || 'there',
    phone,
    doctor_name: clean((doctor as Record<string, unknown>).name, 180) || 'your doctor',
    clinic_name: clean((clinic as Record<string, unknown>).name, 180) || 'our clinic',
    medicines,
    pdf_url: pdfUrl,
    pdf_storage_path: clean(prescription.pdf_storage_path, 500) || null,
    requested_by: userData.user.id,
  };

  const timestamp = String(Date.now());
  const canonicalBody = canonicalStringify(payload);
  const signature = await hmacSha256Hex(internalSecret, `${timestamp}.${canonicalBody}`);

  const delivery = await fetch(n8nUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Timestamp': timestamp,
      'X-Internal-Signature': `sha256=${signature}`,
    },
    body: canonicalBody,
  });

  if (!delivery.ok) {
    await supabase
      .from('prescriptions')
      .update({ delivery_status: 'failed' })
      .eq('id', prescription.id);

    const text = await delivery.text().catch(() => '');
    return jsonResponse(502, {
      error: 'Prescription delivery workflow failed',
      status: delivery.status,
      detail: text.slice(0, 300),
    });
  }

  return jsonResponse(200, { status: 'ok', message: 'Prescription delivery queued' });
});
