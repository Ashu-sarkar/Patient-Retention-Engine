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

const configuredOrigins = (Deno.env.get('DOCTOR_DASHBOARD_ORIGIN') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_ORIGIN_PATTERNS = [
  /^https:\/\/vaitalcare-doctor(?:-[a-z0-9-]+)?\.vercel\.app$/i,
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
];

function originMatchesPattern(origin: string, pattern: string): boolean {
  if (!pattern.includes('*')) return pattern === origin;
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i',
  );
  return re.test(origin);
}

function isOriginAllowed(origin: string): boolean {
  if (!origin) return false;
  for (const allowed of configuredOrigins) {
    if (originMatchesPattern(origin, allowed)) return true;
  }
  for (const re of DEFAULT_ORIGIN_PATTERNS) {
    if (re.test(origin)) return true;
  }
  return false;
}

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  if (isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function jsonResponse(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), 'Content-Type': 'application/json' },
  });
}

function clean(value: unknown, max = 1000) {
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

async function buildShortPdfLink(
  supabaseUrl: string,
  secret: string,
  prescriptionId: string,
): Promise<string> {
  const token = (await hmacSha256Hex(secret, `pdf:${prescriptionId}`)).slice(0, 32);
  const base = supabaseUrl.replace(/\/$/, '');
  return `${base}/functions/v1/prescription-pdf?id=${prescriptionId}&t=${token}`;
}

function summariseMedicines(medicines: Medicine[]) {
  return medicines
    .map((m, index) => {
      const name = clean(m.medicine_name, 180);
      const parts = [m.dosage, m.frequency, m.timing, m.duration]
        .map((v) => clean(v, 80))
        .filter(Boolean)
        .join(', ');
      return name ? `${index + 1}. ${name}${parts ? ` - ${parts}` : ''}` : '';
    })
    .filter(Boolean)
    .join('; ')
    .slice(0, 900) || 'As listed in your prescription PDF';
}

function parseTwilioResponse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split('&')) {
    const [k, v] = part.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

async function sendTwilioWhatsApp(opts: {
  accountSid: string;
  authToken: string;
  from: string;
  toPhone: string;
  contentSid?: string;
  contentVariables?: Record<string, string>;
  body?: string;
  mediaUrl?: string;
  statusCallback?: string;
}) {
  const form = new URLSearchParams();
  form.set('From', opts.from.startsWith('whatsapp:') ? opts.from : `whatsapp:${opts.from}`);
  form.set('To', opts.toPhone.startsWith('whatsapp:') ? opts.toPhone : `whatsapp:${opts.toPhone}`);

  if (opts.contentSid) {
    form.set('ContentSid', opts.contentSid);
    form.set('ContentVariables', JSON.stringify(opts.contentVariables || {}));
  } else {
    if (opts.body) form.set('Body', opts.body);
    if (opts.mediaUrl) form.set('MediaUrl', opts.mediaUrl);
  }
  if (opts.statusCallback) form.set('StatusCallback', opts.statusCallback);

  const auth = btoa(`${opts.accountSid}:${opts.authToken}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    },
  );

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = parseTwilioResponse(text);
  }

  return { ok: res.ok, status: res.status, json, text };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);

  if (req.method === 'OPTIONS') {
    const origin = req.headers.get('Origin') || '';
    if (origin && !isOriginAllowed(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') return jsonResponse(req, 405, { error: 'Method not allowed' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const internalSecret = Deno.env.get('INTERNAL_WEBHOOK_SECRET') || '';
  const twilioSid = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
  const twilioToken = Deno.env.get('TWILIO_AUTH_TOKEN') || '';
  const twilioFrom = Deno.env.get('TWILIO_WHATSAPP_FROM') || '';
  const contentSid = Deno.env.get('TWILIO_CONTENT_PRESCRIPTION_DELIVERY') || '';
  const statusCallback = Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || '';

  if (!supabaseUrl || !supabaseAnonKey || !serviceKey || !internalSecret) {
    return jsonResponse(req, 500, { error: 'Prescription delivery gateway is not configured' });
  }
  if (!twilioSid || !twilioToken || !twilioFrom) {
    return jsonResponse(req, 500, {
      error: 'Twilio secrets missing on prescription-delivery function (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM)',
    });
  }

  const authorization = req.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return jsonResponse(req, 401, { error: 'Authentication required' });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, 400, { error: 'Invalid JSON body' });
  }

  const prescriptionId = clean(body.prescription_id, 80);
  if (!/^[0-9a-f-]{36}$/i.test(prescriptionId)) {
    return jsonResponse(req, 400, { error: 'prescription_id must be a UUID' });
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return jsonResponse(req, 401, { error: 'Invalid doctor session' });

  const { data: prescription, error: prescriptionError } = await supabase
    .from('prescriptions')
    .select(`
      id,
      status,
      patient_id,
      visit_id,
      delivery_status,
      pdf_url,
      follow_up_required,
      follow_up_date,
      doctor_snapshot,
      clinic_snapshot,
      patient:patients(id, name, phone),
      medicines:prescription_medicines(
        medicine_name,
        dosage,
        frequency,
        timing,
        duration,
        sort_order
      )
    `)
    .eq('id', prescriptionId)
    .single();

  if (prescriptionError || !prescription) {
    return jsonResponse(req, 404, { error: 'Prescription not found or not accessible' });
  }

  if (prescription.status !== 'issued') {
    return jsonResponse(req, 409, { error: 'Only issued prescriptions can be delivered' });
  }

  if (prescription.delivery_status === 'sent') {
    return jsonResponse(req, 409, { error: 'Prescription was already sent' });
  }

  const patient = Array.isArray(prescription.patient)
    ? prescription.patient[0]
    : prescription.patient;
  const phone = clean(patient?.phone, 20);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    return jsonResponse(req, 422, { error: 'Patient phone is missing or invalid' });
  }

  const pdfUrl = clean(prescription.pdf_url, 3000);
  if (!/^https:\/\//i.test(pdfUrl)) {
    return jsonResponse(req, 422, { error: 'Prescription PDF URL must be an HTTPS signed URL' });
  }

  const doctor = prescription.doctor_snapshot as Record<string, unknown> || {};
  const clinic = prescription.clinic_snapshot as Record<string, unknown> || {};
  const patientName = clean(patient?.name, 180) || 'there';
  const doctorName = clean(doctor.name, 180) || 'your doctor';
  const clinicName = clean(clinic.name, 180) || 'our clinic';
  const medicines = (Array.isArray(prescription.medicines) ? prescription.medicines : []) as Medicine[];
  const medicineSummary = summariseMedicines(medicines);
  const shortPdfLink = await buildShortPdfLink(supabaseUrl, internalSecret, prescription.id);
  const followUpDate = clean(prescription.follow_up_date, 40);
  const followUpText = prescription.follow_up_required === 'Yes' && followUpDate
    ? `Follow-up date: ${followUpDate}.`
    : 'No follow-up date has been scheduled.';
  const messageBody =
    `Hi ${patientName}, your prescription from ${doctorName} at ${clinicName} is ready. ` +
    `Medicines: ${medicineSummary}. ${followUpText} Open PDF: ${shortPdfLink}`;

  const scheduledDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // 1) Approved template card (short link in {{6}} — full signed URLs break Twilio variables)
  let twilioResult = contentSid
    ? await sendTwilioWhatsApp({
        accountSid: twilioSid,
        authToken: twilioToken,
        from: twilioFrom,
        toPhone: phone,
        contentSid,
        contentVariables: {
          '1': patientName,
          '2': doctorName,
          '3': clinicName,
          '4': medicineSummary,
          '5': followUpText,
          '6': shortPdfLink,
        },
        statusCallback: statusCallback || undefined,
      })
    : { ok: false, status: 0, json: {}, text: 'No content template configured' };

  // 2) Fallback: attach PDF directly when template fails (works inside 24h session window)
  if (!twilioResult.ok) {
    twilioResult = await sendTwilioWhatsApp({
      accountSid: twilioSid,
      authToken: twilioToken,
      from: twilioFrom,
      toPhone: phone,
      body: messageBody,
      mediaUrl: pdfUrl,
      statusCallback: statusCallback || undefined,
    });
  }

  if (!twilioResult.ok) {
    await supabase.from('prescriptions').update({ delivery_status: 'failed' }).eq('id', prescription.id);
    const twilioError = String((twilioResult.json as Record<string, unknown>).message || twilioResult.text).slice(0, 300);
    return jsonResponse(req, 502, {
      error: 'WhatsApp delivery failed',
      twilio_status: twilioResult.status,
      detail: twilioError,
    });
  }

  const messageSid = clean(
    (twilioResult.json as Record<string, unknown>).sid ||
      (twilioResult.json as Record<string, unknown>).Sid,
    80,
  );

  await supabase.from('prescriptions').update({ delivery_status: 'sent' }).eq('id', prescription.id);

  await admin.from('message_logs').insert({
    patient_id: prescription.patient_id,
    patient_name: patientName,
    phone,
    workflow_name: 'prescription-delivery-edge',
    message_type: 'prescription_pdf',
    message_sent: messageBody,
    sent_at: new Date().toISOString(),
    scheduled_date: scheduledDate,
    delivery_status: 'sent',
    provider_message_id: messageSid,
    twilio_message_sid: messageSid,
  });

  return jsonResponse(req, 200, {
    status: 'ok',
    message: 'Prescription sent on WhatsApp',
    twilio_message_sid: messageSid,
    pdf_link: shortPdfLink,
  });
});
