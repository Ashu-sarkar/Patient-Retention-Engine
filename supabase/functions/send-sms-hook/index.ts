import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

type HookPayload = {
  user: { phone?: string };
  sms: { otp?: string };
};

function hookSecret(): string {
  const raw = (Deno.env.get('SEND_SMS_HOOK_SECRETS') || Deno.env.get('SEND_SMS_HOOK_SECRET') || '').trim();
  if (!raw) return '';
  // standardwebhooks expects whsec_<base64> or raw base64 after stripping version prefix.
  return raw.replace(/^v\d+,whsec_/, '').replace(/^whsec_/, '');
}

function twilioBasicAuth(): string | null {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (!sid || !token) return null;
  return `Basic ${btoa(`${sid}:${token}`)}`;
}

function whatsappFrom(): string {
  const from = (Deno.env.get('TWILIO_WHATSAPP_FROM') || '').trim();
  if (!from) return '';
  return from.startsWith('whatsapp:') ? from : `whatsapp:${from}`;
}

function whatsappTo(phone: string): string {
  const normalized = phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`;
  return `whatsapp:${normalized}`;
}

async function sendWhatsAppOtp(phone: string, otp: string) {
  const auth = twilioBasicAuth();
  const from = whatsappFrom();
  const contentSid = (Deno.env.get('TWILIO_CONTENT_DOCTOR_OTP') || '').trim();
  if (!auth || !from) {
    throw new Error('Twilio WhatsApp credentials are not configured for send-sms-hook');
  }
  if (!contentSid) {
    throw new Error('TWILIO_CONTENT_DOCTOR_OTP is not configured — required for WhatsApp OTP outside 24h window');
  }

  const body = new URLSearchParams({
    To: whatsappTo(phone),
    From: from,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify({ '1': otp }),
  });

  const statusCallback = (Deno.env.get('TWILIO_STATUS_CALLBACK_URL') || '').trim();
  if (statusCallback) body.set('StatusCallback', statusCallback);

  const sid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload.code ? ` (${payload.code})` : '';
    const message = typeof payload.message === 'string'
      ? `${payload.message}${code}`
      : `Twilio returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const status = String(payload.status || '');
  if (status && !['queued', 'accepted', 'sending', 'sent', 'delivered'].includes(status)) {
    throw new Error(`Twilio message status: ${status}`);
  }

  return payload;
}

function jsonError(status: number, message: string) {
  return new Response(
    JSON.stringify({ error: { http_code: status, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (raw.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

function extractOtp(event: HookPayload): string {
  const sms = event.sms as Record<string, unknown> | undefined;
  const candidates = [
    sms?.otp,
    sms?.code,
    sms?.token,
    (event as Record<string, unknown>).otp,
  ];
  for (const value of candidates) {
    const token = String(value || '').trim();
    if (/^\d{4,8}$/.test(token)) return token;
  }
  return '';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonError(405, 'Method not allowed');
  }

  const secret = hookSecret();
  if (!secret) {
    return jsonError(500, 'SEND_SMS_HOOK_SECRETS is not configured');
  }

  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);

  let event: HookPayload;
  try {
    event = new Webhook(secret).verify(payload, headers) as HookPayload;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid hook signature';
    console.error('send-sms-hook signature verification failed:', message);
    return jsonError(500, message);
  }

  const phone = normalizePhone(String(event.user?.phone || ''));
  const otp = extractOtp(event);
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    // Never log the raw payload — it contains PII (phone) and the OTP.
    console.error('send-sms-hook: invalid or missing phone in hook payload');
    return jsonError(500, 'Invalid phone in hook payload');
  }
  if (!otp) {
    console.error('send-sms-hook: missing OTP in hook payload');
    return jsonError(500, 'OTP missing in hook payload');
  }

  try {
    await sendWhatsAppOtp(phone, otp);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to send WhatsApp OTP';
    console.error('send-sms-hook delivery failed:', message);
    return jsonError(500, message);
  }
});
