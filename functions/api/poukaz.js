/**
 * Cloudflare Pages Function – /api/poukaz
 *
 * Zpracuje objednávku dárkového poukazu:
 *   1. Vygeneruje variabilní symbol (6 číslic)
 *   2. Pošle email zákazníkovi (platební instrukce)
 *   3. Pošle email Lence (notifikace o nové objednávce)
 *
 * Potřebné proměnné prostředí (nastavit v Cloudflare Pages > Settings > Environment variables):
 *   RESEND_API_KEY  – API klíč z resend.com (free tier = 3 000 emailů/měsíc)
 *   BANK_ACCOUNT    – číslo účtu (např. "1234567890/0800")
 *   OWNER_EMAIL     – email Lenky (např. "maderoterapieuh@gmail.com")
 *   FROM_EMAIL      – ověřená odesílající adresa v Resend (např. "poukazy@maderoterapieuh.cz")
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS hlavičky
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.maderoterapieuh.cz',
  };

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Neplatná data.' }), { status: 400, headers });
  }

  const { type, service, amount, recipientName, occasion, message, buyerName, buyerEmail, buyerPhone } = body;

  // Základní validace
  if (!buyerName || !buyerEmail) {
    return new Response(JSON.stringify({ error: 'Chybí jméno nebo email.' }), { status: 400, headers });
  }
  if (type === 'service' && !service) {
    return new Response(JSON.stringify({ error: 'Není vybrána procedura.' }), { status: 400, headers });
  }
  if (type === 'amount' && (!amount || parseInt(amount) < 200)) {
    return new Response(JSON.stringify({ error: 'Neplatná hodnota poukazu.' }), { status: 400, headers });
  }

  // Sekvenční číslo poukazu z KV (EL.082, EL.083, …)
  let voucherNum = 82;
  if (env.POUKAZY_KV) {
    const stored = await env.POUKAZY_KV.get('poukaz_counter');
    voucherNum = stored ? parseInt(stored) + 1 : 82;
    await env.POUKAZY_KV.put('poukaz_counter', String(voucherNum));
  }
  const vs = String(voucherNum);
  const voucherCode = `EL.${String(voucherNum).padStart(3, '0')}`;

  // Co je na poukazu
  const voucherLabel = type === 'service' ? service : `Poukaz ${parseInt(amount).toLocaleString('cs-CZ')} Kč`;
  const displayAmount = type === 'service'
    ? extractPrice(service)
    : `${parseInt(amount).toLocaleString('cs-CZ')} Kč`;

  // Uložit poukaz do Supabase jako 'cekajici' (čeká na potvrzení platby)
  let supaDebug = 'skipped';
  const supaUrl = (env.SUPABASE_URL || '').trim();
  const supaKey = (env.SUPABASE_ANON_KEY || '').trim();
  if (supaUrl && supaKey) {
    const todayStr = new Date().toISOString().split('T')[0];
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + 6);
    const expiryStr = expiry.toISOString().split('T')[0];
    const hodnotaDb = type === 'service' ? service : displayAmount;
    try {
      const supaRes = await fetch(`${supaUrl}/rest/v1/darkove_poukazy`, {
        method: 'POST',
        headers: {
          'apikey': supaKey,
          'Authorization': `Bearer ${supaKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          cislo: voucherCode,
          hodnota: hodnotaDb,
          jmeno_kupujiciho: buyerName,
          email_kupujiciho: buyerEmail,
          datum_vystaveni: todayStr,
          datum_expirace: expiryStr,
          stav: 'cekajici',
          poznamka: 'Objednáno online – čeká na potvrzení platby',
        }),
      });
      if (!supaRes.ok) {
        const errText = await supaRes.text();
        console.error(`Supabase insert error ${supaRes.status}:`, errText);
        supaDebug = `${supaRes.status}: ${errText}`;
      } else {
        supaDebug = 'ok';
      }
    } catch (err) {
      console.error('Supabase poukaz insert error:', err);
      supaDebug = `exception: ${err.message}`;
    }
  }

  const bankAccount = env.BANK_ACCOUNT || 'DOPLŇTE ČÍSLO ÚČTU';
  const ownerEmail = env.OWNER_EMAIL || 'maderoterapieuh@gmail.com';
  const fromEmail = env.FROM_EMAIL || 'noreply@maderoterapieuh.cz';
  const resendKey = env.RESEND_API_KEY;

  if (!resendKey) {
    console.error('RESEND_API_KEY není nastaveno!');
    return new Response(JSON.stringify({ vs, voucherCode, amount: displayAmount, bank: bankAccount, warning: 'Email nebyl odeslán – chybí RESEND_API_KEY.' }), { status: 200, headers });
  }

  // ── EMAIL ZÁKAZNÍKOVI ──────────────────────────────────────────────────────
  const customerEmailHtml = `
<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F8F7F2;font-family:'Jost',Arial,sans-serif;color:#1C2519;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F7F2;padding:40px 20px;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #D8D4C5;overflow:hidden;">
        <!-- Header -->
        <tr><td style="background:#313D30;padding:32px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:11px;letter-spacing:.12em;color:rgba(255,255,255,.5);text-transform:uppercase;">Maderoterapie UH – Bc. Lenka Hanáčková</p>
          <h1 style="margin:0;font-size:26px;font-weight:300;color:#fff;letter-spacing:.02em;">Potvrzení objednávky</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:36px 40px;">
          <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#4a4a38;">Dobrý den, <strong>${escHtml(buyerName)}</strong>,</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.8;color:#7A7A68;">Děkujeme za objednávku dárkového poukazu. Pro dokončení objednávky prosím proveďte platbu bankovním převodem na níže uvedené údaje. Po připsání platby vám do 24 hodin zašleme poukaz emailem.</p>

          <!-- Poukaz box -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F7F2;border:1px solid #D8D4C5;border-radius:10px;margin-bottom:28px;">
            <tr><td style="padding:8px 20px;border-bottom:1px solid #EEEADE;font-size:10px;letter-spacing:.1em;color:#7A7A68;text-transform:uppercase;">Objednávka</td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #EEEADE;">
              <span style="font-size:12px;color:#7A7A68;">Obsah poukazu</span><br>
              <strong style="font-size:14px;">${escHtml(voucherLabel)}</strong>
            </td></tr>
            ${message ? `<tr><td style="padding:12px 20px;border-bottom:1px solid #EEEADE;">
              <span style="font-size:12px;color:#7A7A68;">Vzkaz</span><br>
              <em style="font-size:13px;color:#4a4a38;">${escHtml(message)}</em>
            </td></tr>` : ''}
          </table>

          <!-- Platební údaje -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFF9EE;border:1px solid #D8C87A;border-radius:10px;margin-bottom:28px;">
            <tr><td style="padding:8px 20px;border-bottom:1px solid #EEE0A0;font-size:10px;letter-spacing:.1em;color:#8A7430;text-transform:uppercase;">Platební instrukce</td></tr>
            <tr><td style="padding:10px 20px;border-bottom:1px solid #EEE0A0;"><span style="font-size:12px;color:#8A7430;">Číslo účtu</span><br><strong style="font-size:15px;">${escHtml(bankAccount)}</strong></td></tr>
            <tr><td style="padding:10px 20px;border-bottom:1px solid #EEE0A0;"><span style="font-size:12px;color:#8A7430;">Variabilní symbol</span><br><strong style="font-size:20px;color:#A8903A;">${vs}</strong></td></tr>
            <tr><td style="padding:10px 20px;border-bottom:1px solid #EEE0A0;"><span style="font-size:12px;color:#8A7430;">Částka</span><br><strong style="font-size:20px;color:#A8903A;">${displayAmount}</strong></td></tr>
            <tr><td style="padding:10px 20px;"><span style="font-size:12px;color:#8A7430;">Zpráva pro příjemce</span><br><strong style="font-size:14px;">${voucherCode}</strong></td></tr>
          </table>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8F7F2;border:1px solid #D8D4C5;border-radius:10px;margin-bottom:24px;">
            <tr><td style="padding:8px 20px;border-bottom:1px solid #EEEADE;font-size:10px;letter-spacing:.1em;color:#7A7A68;text-transform:uppercase;">Podmínky poukazu</td></tr>
            <tr><td style="padding:12px 20px;font-size:13px;color:#7A7A68;line-height:1.7;">
              • Platnost poukazu je <strong style="color:#1C2519;">6 měsíců</strong> od zakoupení.<br>
              • Termín je nutné objednat <strong style="color:#1C2519;">nejpozději 30 dnů před vypršením platnosti</strong>.<br>
              • Poukaz lze uplatnit na libovolnou proceduru dle aktuálního ceníku.<br>
              • Pokud je hodnota poukazu vyšší než cena procedury, zbývající část propadá.<br>
              • Lze kombinovat více poukazů na jednu návštěvu.
            </td></tr>
          </table>
          <p style="margin:0 0 24px;font-size:13px;line-height:1.8;color:#7A7A68;">V případě dotazů nás neváhejte kontaktovat na <a href="mailto:maderoterapieuh@gmail.com" style="color:#A8903A;">maderoterapieuh@gmail.com</a> nebo na tel. <a href="tel:+420776323427" style="color:#A8903A;">+420 776 323 427</a>.</p>

          <p style="margin:0;font-size:14px;color:#4a4a38;">S pozdravem,<br><strong>Bc. Lenka Hanáčková</strong><br><span style="font-size:12px;color:#7A7A68;">Maderoterapie UH, Hradební 1543, Uherské Hradiště</span></p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#F8F7F2;padding:20px 40px;text-align:center;border-top:1px solid #D8D4C5;">
          <p style="margin:0;font-size:11px;color:#aaa;">© 2026 Maderoterapie UH – Bc. Lenka Hanáčková · <a href="https://www.maderoterapieuh.cz" style="color:#aaa;">maderoterapieuh.cz</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // ── NOTIFIKACE LENCE ───────────────────────────────────────────────────────
  const ownerEmailHtml = `
<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;color:#1C2519;padding:20px;">
  <h2 style="color:#313D30;">🎁 Nová objednávka dárkového poukazu</h2>
  <table style="border-collapse:collapse;width:100%;max-width:500px;">
    <tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;width:160px;">Variabilní symbol</td><td style="padding:8px 12px;border:1px solid #D8D4C5;font-size:18px;color:#A8903A;font-weight:bold;">${vs}</td></tr>
    <tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Kupující</td><td style="padding:8px 12px;border:1px solid #D8D4C5;">${escHtml(buyerName)}</td></tr>
    <tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Email kupujícího</td><td style="padding:8px 12px;border:1px solid #D8D4C5;"><a href="mailto:${escHtml(buyerEmail)}">${escHtml(buyerEmail)}</a></td></tr>
    ${buyerPhone ? `<tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Telefon</td><td style="padding:8px 12px;border:1px solid #D8D4C5;">${escHtml(buyerPhone)}</td></tr>` : ''}
    <tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Obsah poukazu</td><td style="padding:8px 12px;border:1px solid #D8D4C5;">${escHtml(voucherLabel)}</td></tr>
    <tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Částka k platbě</td><td style="padding:8px 12px;border:1px solid #D8D4C5;font-size:18px;color:#A8903A;font-weight:bold;">${displayAmount}</td></tr>
    <tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Obdarovaný</td><td style="padding:8px 12px;border:1px solid #D8D4C5;">${recipientName ? escHtml(recipientName) : '—'}</td></tr>
    ${occasion ? `<tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Příležitost</td><td style="padding:8px 12px;border:1px solid #D8D4C5;">${escHtml(occasion)}</td></tr>` : ''}
    ${message ? `<tr><td style="padding:8px 12px;background:#F8F7F2;border:1px solid #D8D4C5;font-weight:bold;">Vzkaz</td><td style="padding:8px 12px;border:1px solid #D8D4C5;font-style:italic;">${escHtml(message)}</td></tr>` : ''}
  </table>
  <p style="margin-top:20px;color:#7A7A68;font-size:13px;">Po přijetí platby (VS: <strong>${vs}</strong>, číslo poukazu: <strong>${voucherCode}</strong>) vytvoř a pošli poukaz na <strong>${escHtml(buyerEmail)}</strong>.</p>
</body>
</html>`;

  // Odešli oba emaily přes Resend
  const emailRequests = [
    sendEmail(resendKey, {
      from: fromEmail,
      to: buyerEmail,
      subject: `Potvrzení objednávky poukazu – VS ${vs} | Maderoterapie UH`,
      html: customerEmailHtml,
    }),
    sendEmail(resendKey, {
      from: fromEmail,
      to: ownerEmail,
      subject: `🎁 Nová objednávka poukazu – ${buyerName} – VS ${vs}`,
      html: ownerEmailHtml,
    }),
  ];

  try {
    await Promise.all(emailRequests);
  } catch (err) {
    console.error('Email error:', err);
    // Vrátíme VS i přes chybu emailu – customer viděl potvrzení
    return new Response(JSON.stringify({ vs, voucherCode, amount: displayAmount, bank: bankAccount, warning: 'Email se nepodařilo odeslat.' }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ vs, voucherCode, amount: displayAmount, bank: bankAccount, _supa: supaDebug }), { status: 200, headers });
}

// Odešle email přes Resend API
async function sendEmail(apiKey, { from, to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
  return res.json();
}

// Vytáhne cenu z textu procedury (např. "Maderoterapie těla (90 min) – 1 550 Kč" → "1 550 Kč")
function extractPrice(serviceStr) {
  const match = serviceStr.match(/[\d\s]+\s*Kč/);
  return match ? match[0].trim() : '—';
}

// Escape HTML
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// OPTIONS pro CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://www.maderoterapieuh.cz',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
