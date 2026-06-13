import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

type HookPayload = {
  user: { phone?: string };
  sms: { otp?: string };
};

function hookSecret(): string {
  const raw = Deno.env.get('SEND_SMS_HOOK_SECRETS') || Deno.env.get('SEND_SMS_HOOK_SECRET') || '';
  return raw.replace(/^v\d+,whsec_/, '');
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
  if (!auth || !from) {
    throw new Error('Twilio WhatsApp credentials are not configured for send-sms-hook');
  }

  const body = new URLSearchParams({
    To: whatsappTo(phone),
    From: from,
    Body: `Your VaitalCare doctor dashboard login code is ${otp}. It expires in 10 minutes.`,
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
    const message = typeof payload.message === 'string'
      ? payload.message
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
    return jsonError(400, message);
  }

  const phone = String(event.user?.phone || '').trim();
  const otp = String(event.sms?.otp || '').trim();
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    return jsonError(400, 'A valid E.164 phone number is required');
  }
  if (!/^\d{4,8}$/.test(otp)) {
    return jsonError(400, 'A valid OTP is required');
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
