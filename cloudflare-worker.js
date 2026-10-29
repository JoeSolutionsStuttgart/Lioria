/* ============================================================
   CHRONIK — Cloudflare Worker für die Bilder (R2)
   ============================================================
   Aufgabe: Bilder annehmen und ausliefern, aber nur für
   angemeldete Personen — und nur solange die Gratis-Grenzen
   nicht erreicht sind.

   Der Worker ist die Tür zum Bildspeicher. Ohne ihn müsste der
   R2-Schlüssel in der Webseite stehen, und den könnte jeder lesen.

   Einrichten (steht ausführlich in der Anleitung):
     1. Cloudflare → R2 → Bucket "chronik-bilder" anlegen
     2. Workers & Pages → Create Worker → diesen Code einfügen
     3. Settings → Bindings → R2 bucket:  Variable BUCKET  →  chronik-bilder
     4. Settings → Variables:
          SUPABASE_URL      = https://xxxx.supabase.co
          SUPABASE_ANON_KEY = eyJ… (anon public)
          ALLOWED_ORIGIN    = https://deinname.github.io
          MAX_BYTES         = 8000000000     (8 GB von 10 GB)
          MAX_UPLOADS_DAY   = 2000
          MAX_GETS_DAY      = 60000
          TT_MAX_DAY        = 25   (optional: feste KI-Obergrenze pro Tag,
                                    gilt immer, auch wenn die Chronik sie ausschaltet)
     5. Adresse des Workers in chronik-config.js als r2Worker eintragen
   ============================================================ */

const KEY_RE = /^[0-9a-f-]{36}\/[0-9a-z._-]{1,80}$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/upload" && request.method === "POST") return await upload(request, env, cors);
      if (url.pathname === "/notify" && request.method === "POST") return await notify(request, env, cors);
      if (url.pathname === "/gast/upload" && request.method === "POST") return await gastUpload(request, env, cors);
      if (url.pathname.startsWith("/gast/img/") && request.method === "GET") return await gastBild(request, env, url, cors);
      if (url.pathname.startsWith("/img/") && request.method === "GET") return await serve(request, env, url, cors);
      if (url.pathname === "/delete" && request.method === "POST") return await drop(request, env, cors);
      if (url.pathname === "/timetable" && request.method === "POST") return await timetable(request, env, cors);
      if (url.pathname === "/state") {
        let auth = "ok";
        try { await whoami(request, env); }
        catch (e) { auth = (e && e.code) || "D-06"; }
        return json({
          ok: true,
          auth: auth,
          bucket: !!env.BUCKET,
          ai: !!env.AI,
          timetable: true,
          version: "Bau 92",
          supabase: baseUrl(env.SUPABASE_URL) || "leer",
          keyLen: String(env.SUPABASE_ANON_KEY || "").trim().length,
          origin: request.headers.get("Origin") || "",
          allowed: String(env.ALLOWED_ORIGIN || "*"),
          allowOrigin: cors["Access-Control-Allow-Origin"]
        }, 200, cors);
      }
      return json({ error: "D-11" }, 404, cors);
    } catch (e) {
      return json({ error: (e && e.code) || "D-06" }, (e && e.status) || 500, cors);
    }
  }
};

/* Nur der Ursprung zählt (Schema + Domain). Ein mitkopierter Pfad wie
   "https://name.github.io/chronik/" ist der häufigste Einrichtungsfehler —
   er wird hier abgeschnitten, damit der Browser die Antwort annimmt. */
function originOf(v) {
  const s = String(v || "").trim();
  if (!s || s === "*") return s;
  try { return new URL(s).origin; }
  catch (e) {
    const m = s.match(/^https?:\/\/[^/]+/i);
    return m ? m[0] : s.replace(/\/.*$/, "");
  }
}

/* Kurze Mail an eine andere Person — nur, wenn sie das eingestellt hat.
   Verschickt über die Brevo-Schnittstelle; der Schlüssel liegt als
   Worker-Variable BREVO_KEY, der Absender als BREVO_FROM. */
/* Die Infomails tragen das Gesicht der Chronik — gebaut aus Tabellen und
   Inline-Stilen, mit Outlook-Knopf und Georgia als Rückfall, damit sie in
   jedem Mailprogramm gleich aussehen. */
const MAIL_VORLAGE = "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\">\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" lang=\"de\">\n<head>\n<meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\n<meta name=\"x-apple-disable-message-reformatting\">\n<meta name=\"format-detection\" content=\"telephone=no, date=no, address=no, email=no, url=no\">\n<meta name=\"color-scheme\" content=\"light\">\n<meta name=\"supported-color-schemes\" content=\"light\">\n<title>@@TITEL@@</title>\n<!--[if mso]>\n<noscript><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>\n<style>body, table, td, p, a, span { font-family: Georgia, 'Times New Roman', serif !important; }</style>\n<![endif]-->\n<!--[if !mso]><!-->\n<link href=\"https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600;8..60,700&amp;display=swap\" rel=\"stylesheet\">\n<!--<![endif]-->\n<style>\n  html, body { margin: 0 !important; padding: 0 !important; width: 100% !important; }\n  * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }\n  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }\n  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }\n  a[x-apple-data-detectors], #MessageViewBody a, u + #body a { color: inherit !important; text-decoration: none !important; font-size: inherit !important; font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important; }\n  @media screen and (max-width: 620px) {\n    .col { width: 100% !important; max-width: 100% !important; }\n    .pad { padding-left: 22px !important; padding-right: 22px !important; }\n    .h1 { font-size: 28px !important; line-height: 32px !important; }\n    .wort { font-size: 38px !important; line-height: 40px !important; }\n    .rechts { display: none !important; }\n  }\n</style>\n</head>\n<body id=\"body\" style=\"margin:0; padding:0; width:100%; background-color:#f3f2f2; -webkit-font-smoothing:antialiased;\" bgcolor=\"#f3f2f2\">\n<div style=\"display:none; font-size:1px; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; mso-hide:all; color:#f3f2f2;\">@@PRE@@&#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; &#8199;&#65279;&#847; </div>\n<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" bgcolor=\"#f3f2f2\" style=\"width:100%; background-color:#f3f2f2;\">\n<tr><td align=\"center\" valign=\"top\" style=\"padding:32px 10px 44px;\">\n<!--[if mso]><table role=\"presentation\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\"><tr><td><![endif]-->\n<table role=\"presentation\" class=\"col\" width=\"600\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" align=\"center\" style=\"width:100%; max-width:600px;\">\n\n<tr><td class=\"pad\" style=\"padding:0 30px; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:11px; line-height:16px; letter-spacing:3px; text-transform:uppercase; color:#006c8c;\">Was ihr erlebt habt, in einer Linie</td></tr>\n<tr><td class=\"pad\" style=\"padding:10px 30px 0;\">\n  <table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>\n    <!--LOGO--><td valign=\"middle\" width=\"56\" style=\"padding-right:10px;\"><img src=\"@@LOGO@@\" width=\"46\" height=\"46\" alt=\"\" style=\"display:block; width:46px; height:46px; border:0;\"></td><!--/LOGO-->\n    <td valign=\"middle\" class=\"wort\" style=\"font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:46px; line-height:48px; font-weight:bold; color:#3d63d9; mso-line-height-rule:exactly;\">@@NAME@@</td>\n  </tr></table>\n</td></tr>\n<tr><td class=\"pad\" style=\"padding:16px 30px 0;\">\n  <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>\n    <td width=\"25%\" height=\"4\" bgcolor=\"#7c4ad8\" style=\"height:4px; font-size:0; line-height:0; mso-line-height-rule:exactly; background-color:#7c4ad8;\">&nbsp;</td>\n    <td width=\"25%\" height=\"4\" bgcolor=\"#3d63d9\" style=\"height:4px; font-size:0; line-height:0; mso-line-height-rule:exactly; background-color:#3d63d9;\">&nbsp;</td>\n    <td width=\"25%\" height=\"4\" bgcolor=\"#1f84cf\" style=\"height:4px; font-size:0; line-height:0; mso-line-height-rule:exactly; background-color:#1f84cf;\">&nbsp;</td>\n    <td width=\"25%\" height=\"4\" bgcolor=\"#13a77c\" style=\"height:4px; font-size:0; line-height:0; mso-line-height-rule:exactly; background-color:#13a77c;\">&nbsp;</td>\n  </tr></table>\n</td></tr>\n<tr><td class=\"pad\" style=\"padding:8px 30px 0;\">\n  <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>\n    <td style=\"font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:11px; line-height:16px; letter-spacing:2px; text-transform:uppercase; color:#201e1d;\">Ereignisse &middot; Bilder &middot; Menschen</td>\n    <td class=\"rechts\" align=\"right\" style=\"font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:11px; line-height:16px; letter-spacing:2px; text-transform:uppercase; color:#201e1d;\">@@DATUM@@</td>\n  </tr></table>\n</td></tr>\n<tr><td class=\"pad\" style=\"padding:8px 30px 0;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td height=\"1\" bgcolor=\"#d9d6d4\" style=\"height:1px; font-size:0; line-height:0; mso-line-height-rule:exactly; background-color:#d9d6d4;\">&nbsp;</td></tr></table></td></tr>\n\n<tr><td class=\"pad\" style=\"padding:42px 30px 0; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:12px; line-height:16px; letter-spacing:2.5px; text-transform:uppercase; color:#b0005a;\">@@KICKER@@</td></tr>\n<tr><td class=\"pad h1\" style=\"padding:10px 30px 0; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:34px; line-height:38px; font-weight:bold; color:#201e1d; mso-line-height-rule:exactly;\">@@TITEL@@</td></tr>\n<tr><td class=\"pad\" style=\"padding:20px 30px 0; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:17px; line-height:27px; color:#3b3836; mso-line-height-rule:exactly;\">@@TEXT@@</td></tr>\n<!--KNOPF--><tr><td class=\"pad\" style=\"padding:14px 30px 0;\">\n  <!--[if mso]>\n  <v:roundrect xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:w=\"urn:schemas-microsoft-com:office:word\" href=\"@@LINK@@\" style=\"height:50px; v-text-anchor:middle; width:300px;\" arcsize=\"6%\" stroke=\"f\" fillcolor=\"#0088b0\">\n  <w:anchorlock/><center style=\"color:#ffffff; font-family:Georgia, serif; font-size:17px; font-weight:bold;\">@@KNOPF@@ &rarr;</center>\n  </v:roundrect>\n  <![endif]-->\n  <!--[if !mso]><!-->\n  <table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>\n    <td bgcolor=\"#0088b0\" style=\"border-radius:3px; background-color:#0088b0;\">\n      <a href=\"@@LINK@@\" target=\"_blank\" style=\"display:inline-block; padding:15px 30px; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:17px; line-height:20px; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:3px;\">@@KNOPF@@&nbsp;&rarr;</a>\n    </td>\n  </tr></table>\n  <!--<![endif]-->\n</td></tr>\n<tr><td class=\"pad\" style=\"padding:22px 30px 0; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:13px; line-height:20px; color:#6b6764;\">Der Knopf geht nicht? Diese Adresse in den Browser kopieren:<br><a href=\"@@LINK@@\" target=\"_blank\" style=\"color:#006c8c; text-decoration:underline; word-break:break-all; word-wrap:break-word; overflow-wrap:anywhere;\">@@LINK@@</a></td></tr><!--/KNOPF-->\n\n\n<tr><td class=\"pad\" style=\"padding:48px 30px 0;\"><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr><td height=\"1\" bgcolor=\"#d9d6d4\" style=\"height:1px; font-size:0; line-height:0; mso-line-height-rule:exactly; background-color:#d9d6d4;\">&nbsp;</td></tr></table></td></tr>\n<tr><td class=\"pad\" style=\"padding:14px 30px 0; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:12px; line-height:19px; color:#6b6764;\">@@FUSS@@</td></tr>\n</table>\n<!--[if mso]></td></tr></table><![endif]-->\n</td></tr>\n</table>\n</body>\n</html>\n";
const MAIL_ABSATZ = "<p style=\"margin:0 0 16px 0; font-family:'Source Serif 4', Georgia, 'Times New Roman', Times, serif; font-size:17px; line-height:27px; color:#3b3836;\">";
function esc(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
const MAIL_KICKER = { test: "Probemail", neu: "Neues Ereignis", zuordnung: "Du bist dabei", vorschau: "Demnächst", kommentar: "Kommentar", freund: "Kontakte" };
/* Name und Logo schickt die Seite aus chronik-config.js mit; das hier ist nur der Rückfall. */
const APP_NAME = "Chronik";
function chronikMail(kind, betreff, text, app, empf, name, logoUrl) {
  name = String(name || APP_NAME).slice(0, 40);
  const base = /^https:\/\/[^\s"<>]+$/i.test(app || "") ? app : "";
  const logo = /^https:\/\/[^\s"<>]+$/i.test(logoUrl || "") ? logoUrl : (base ? base.replace(/[^\/]*$/, "") + "icon-192.png" : "");
  const absatz = esc(text).split(/\n{2,}/).map((p) => MAIL_ABSATZ + p.replace(/\n/g, "<br>") + "</p>").join("");
  const datum = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric", timeZone: "Europe/Berlin" });
  let h = MAIL_VORLAGE;
  if (!logo) h = h.replace(/<!--LOGO-->[\s\S]*?<!--\/LOGO-->/, "");
  if (!base) h = h.replace(/<!--KNOPF-->[\s\S]*?<!--\/KNOPF-->/, "");
  const ersatz = { PRE: esc(String(text).slice(0, 110)), NAME: esc(name), KICKER: esc(MAIL_KICKER[kind] || name), TITEL: esc(betreff), TEXT: absatz, KNOPF: "Zur " + esc(name), LINK: esc(base), LOGO: esc(logo), DATUM: esc(datum),
    FUSS: "Diese Mail kam von deiner " + esc(name) + " an " + esc(empf) + ", weil du sie unter Einstellungen &middot; Benachrichtigungen eingeschaltet hast. Dort schaltest du sie auch wieder ab." };
  return h.replace(/@@([A-Z]+)@@/g, (m, k) => (k in ersatz ? ersatz[k] : m));
}

async function notify(request, env, cors) {
  const me = await whoami(request, env);
  if (!env.BREVO_KEY || !env.BREVO_FROM) return json({ error: "D-18" }, 501, cors);

  const body = await request.json().catch(() => ({}));
  const to = String(body.to || "");
  const kind = String(body.kind || "");
  if (!to || !kind) return json({ error: "D-19" }, 400, cors);

  const base = baseUrl(env.SUPABASE_URL);
  const key = String(env.SUPABASE_ANON_KEY || "").trim();
  const p = await fetch(base + "/rest/v1/profiles?id=eq." + encodeURIComponent(to) + "&select=email,notify,username", {
    headers: { apikey: key, Authorization: "Bearer " + me.token }
  });
  if (!p.ok) return json({ error: "D-19" }, 400, cors);
  const rows = await p.json().catch(() => []);
  const ziel = rows && rows[0];
  if (!ziel || !ziel.email) return json({ error: "D-19" }, 400, cors);
  /* Testmail nur an sich selbst. Alle anderen Mails nur, wenn die
     Person diese Art ausdrücklich angehakt hat — Standard ist aus. */
  if (kind === "test" && to !== me.id) return json({ error: "D-19" }, 400, cors);
  if (kind !== "test" && !(ziel.notify && ziel.notify[kind] === true)) return json({ ok: true, skipped: "abgewaehlt" }, 200, cors);

  const betreff = String(body.subject || body.name || APP_NAME).slice(0, 120);
  const text = String(body.text || "").slice(0, 900);
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": env.BREVO_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: String(body.name || APP_NAME).slice(0, 40), email: env.BREVO_FROM },
      to: [{ email: ziel.email, name: ziel.username || "" }],
      subject: betreff,
      textContent: text + (body.app ? "\n\n" + String(body.app) : ""),
      htmlContent: chronikMail(kind, betreff, text, String(body.app || ""), ziel.email, String(body.name || ""), String(body.logo || ""))
    })
  });
  if (!r.ok) {
    const grund = await r.text().catch(() => "");
    return json({ error: "D-20", detail: String(grund).slice(0, 200) }, 502, cors);
  }
  return json({ ok: true }, 200, cors);
}

function coded(c, status) {
  const e = new Error(c);
  e.code = c;
  e.status = status || 500;
  return e;
}

function corsHeaders(env, request) {
  const raw = String(env.ALLOWED_ORIGIN || "*").trim();
  const origin = request.headers.get("Origin") || "";
  const list = raw === "*" ? ["*"] : raw.split(",").map(originOf).filter(Boolean);
  const ok = list.indexOf("*") >= 0 || (origin && list.indexOf(originOf(origin)) >= 0);
  return {
    "Access-Control-Allow-Origin": ok ? (origin || "*") : (list[0] || "*"),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-chronik-name",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, cors)
  });
}

function baseUrl(v) {
  let s = String(v || "").trim().replace(/^["']|["']$/g, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/\/+$/, "").replace(/\/(auth|rest|storage|realtime)\/v1.*$/i, "").replace(/\/+$/, "");
  return s;
}

async function whoami(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw coded("D-09", 401);

  const base = baseUrl(env.SUPABASE_URL);
  const key = String(env.SUPABASE_ANON_KEY || "").trim().replace(/^["']|["']$/g, "");
  if (!base || !key) throw coded("D-14", 500);

  let r;
  try {
    r = await fetch(base + "/auth/v1/user", {
      headers: { Authorization: "Bearer " + token, apikey: key }
    });
  } catch (e) {
    throw coded("D-16", 502);
  }

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    if (/api ?key/i.test(body)) throw coded("D-17", 401);
    throw coded("D-09", 401);
  }
  const u = await r.json().catch(() => null);
  if (!u || !u.id) throw coded("D-09", 401);
  return { id: u.id, token: token };
}

/* Zähler und Grenzen — der Worker fragt die Chronik-Datenbank. */
async function usage(env, token) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/rpc/usage_snapshot", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    body: "{}"
  });
  if (!r.ok) return null;
  return await r.json();
}

async function bump(env, token, patch) {
  await fetch(env.SUPABASE_URL + "/rest/v1/rpc/bump_usage", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    body: JSON.stringify(patch)
  });
}

function num(v, dflt) { const n = Number(v); return isFinite(n) && n > 0 ? n : dflt; }

async function upload(request, env, cors) {
  const me = await whoami(request, env);
  const u = await usage(env, me.token);
  const maxBytes = num(env.MAX_BYTES, 8000000000);
  const maxUp = num(env.MAX_UPLOADS_DAY, 2000);

  if (u) {
    const bytes = Number(u.bytes || 0);
    const upsToday = Number((u.day && u.day.uploads) || 0);
    if (bytes >= maxBytes) {
      return json({ error: "limit", scope: "speicher",
        message: "Der Fotospeicher ist voll. Es passen keine neuen Bilder mehr hinein, bis ältere gelöscht werden.",
        used: bytes, cap: maxBytes }, 429, cors);
    }
    if (upsToday >= maxUp) {
      return json({ error: "limit", scope: "uploads-heute",
        message: "Für heute sind genug Bilder hochgeladen. Morgen geht es weiter.",
        used: upsToday, cap: maxUp }, 429, cors);
    }
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ error: "D-08" }, 400, cors);
  if (file.size > 25 * 1024 * 1024) return json({ error: "D-05" }, 413, cors);

  /* Handybilder kommen manchmal ohne Typangabe. Darum zählt auch die Endung. */
  const rawName = String(form.get("name") || file.name || "bild");
  const isImage = /^image\//i.test(file.type || "") ||
    /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(rawName);
  if (!isImage) return json({ error: "D-08" }, 415, cors);

  if (!env.BUCKET) return json({ error: "D-12" }, 500, cors);

  const safe = rawName.toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(-60);
  const key = me.id + "/" + Date.now() + "-" + safe;
  if (!KEY_RE.test(key)) return json({ error: "D-08" }, 400, cors);

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream", cacheControl: "private, max-age=3600" }
  });
  await bump(env, me.token, { p_uploads: 1, p_bytes: file.size });

  return json({ key: key, size: file.size }, 200, cors);
}

/* Bilder wegräumen, wenn ein Konto, Ereignis oder Bild verschwindet.
   Ohne das bleiben verwaiste Dateien im Speicher liegen. */
async function drop(request, env, cors) {
  const me = await whoami(request, env);
  if (!env.BUCKET) return json({ error: "D-12" }, 500, cors);
  let keys = [];
  try {
    const body = await request.json();
    keys = Array.isArray(body && body.keys) ? body.keys : [];
  } catch (e) { return json({ error: "D-08" }, 400, cors); }

  let weg = 0, bytes = 0;
  for (const k of keys.slice(0, 500)) {
    const key = String(k || "");
    if (!KEY_RE.test(key)) continue;
    try {
      const kopf = await env.BUCKET.head(key);
      if (kopf && kopf.size) bytes += kopf.size;
      await env.BUCKET.delete(key);
      weg++;
    } catch (e) { /* schon weg */ }
  }
  if (bytes > 0) {
    try { await bump(env, me.token, { p_bytes: -bytes, p_uploads: 0 }); } catch (e) { /* Zähler bleibt */ }
  }
  return json({ ok: true, deleted: weg, bytes: bytes }, 200, cors);
}

/* Offener Bereich: Gäste ohne Konto laden Fotos hoch und sehen sie.
   Geprüft wird über den Gäste-Link (Ereignis + Schlüssel) in Supabase.
   Bei Gästeseiten mit Passwort hängt es als „~passwort“ am Schlüssel. */
async function anonRpc(env, name, body) {
  const key = String(env.SUPABASE_ANON_KEY || "").trim().replace(/^["']|["']$/g, "");
  const r = await fetch(baseUrl(env.SUPABASE_URL) + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: key, Authorization: "Bearer " + key },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) return null;
  return await r.json();
}

async function gastUpload(request, env, cors) {
  if (!env.BUCKET) return json({ error: "D-12" }, 500, cors);
  const form = await request.formData();
  const ev = String(form.get("event") || ""), tk = String(form.get("token") || "");
  const file = form.get("file");
  if (!/^[0-9a-f-]{36}$/i.test(ev) || !/^[A-Za-z0-9_-]{16,64}(~[\s\S]{1,64})?$/.test(tk) || !file || typeof file === "string") return json({ error: "D-08" }, 400, cors);
  if (file.size > 10 * 1024 * 1024) return json({ error: "D-05" }, 413, cors);
  if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.type || "")) return json({ error: "D-08" }, 415, cors);
  const ok = await anonRpc(env, "guest_upload_ok", { p_event: ev, p_token: tk, p_bytes: file.size, p_max_bytes: num(env.MAX_BYTES, 8000000000), p_max_up: num(env.MAX_UPLOADS_DAY, 2000) });
  if (ok !== true) return json({ error: ok === false ? "D-26" : "D-14" }, 403, cors);
  const key = ev + "/gast-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".jpg";
  await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: "private, max-age=3600" } });
  return json({ key: key }, 200, cors);
}

async function gastBild(request, env, url, cors) {
  if (!env.BUCKET) return json({ error: "D-12" }, 500, cors);
  const key = decodeURIComponent(url.pathname.replace(/^\/gast\/img\//, ""));
  const ev = url.searchParams.get("e") || "", tk = url.searchParams.get("t") || "";
  if (!KEY_RE.test(key) || !/^[0-9a-f-]{36}$/i.test(ev)) return json({ error: "D-08" }, 400, cors);
  const ok = await anonRpc(env, "guest_img_ok", { p_event: ev, p_token: tk, p_key: key });
  if (ok !== true) return json({ error: "D-26" }, 403, cors);
  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: "D-04" }, 404, cors);
  const h = new Headers(cors);
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers: h });
}

async function serve(request, env, url, cors) {
  const me = await whoami(request, env);
  const u = await usage(env, me.token);
  const maxGets = num(env.MAX_GETS_DAY, 60000);
  if (u && Number((u.day && u.day.gets) || 0) >= maxGets) {
    return json({ error: "limit", scope: "abrufe-heute",
      message: "Für heute sind sehr viele Bilder abgerufen worden. Morgen ist wieder alles da." }, 429, cors);
  }

  const key = decodeURIComponent(url.pathname.replace(/^\/img\//, ""));
  if (!KEY_RE.test(key)) return json({ error: "D-08" }, 400, cors);

  const obj = await env.BUCKET.get(key);
  if (!obj) return json({ error: "D-04" }, 404, cors);

  await bump(env, me.token, { p_gets: 1, p_bytes_out: Number(obj.size || 0) });

  const h = new Headers(cors);
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("cache-control", "private, max-age=3600");
  return new Response(obj.body, { headers: h });
}


/* Timetable lesen — mit Workers AI (Bindung „AI“ im Worker anlegen).
   Ohne Bindung antwortet der Worker mit D-20 und die Chronik nimmt die
   Texterkennung im Browser. Modell wählbar über die Variable TT_MODEL. */
const TT_PROMPT = "Read the festival or event timetable in this image. Return ONLY valid JSON, no explanation, no markdown, exactly in this form: " +
  "{\"tage\":[{\"label\":\"day as printed, e.g. Friday 12.07.\",\"acts\":[{\"name\":\"act or band\",\"buehne\":\"stage name or empty\",\"von\":\"HH:MM\",\"bis\":\"HH:MM or empty\"}]}]}. " +
  "Use 24-hour times. If the timetable is a grid, read start and end of each act from its position against the time axis and its stage from the row or column header. " +
  "If no day is printed, use one entry with an empty label. Include every act exactly once and do not invent anything.";

function ttText(out) {
  if (out == null) return "";
  if (typeof out === "string") return out;
  let r = out.response !== undefined ? out.response : (out.result && out.result.response !== undefined ? out.result.response : undefined);
  if (r === undefined && out.choices && out.choices[0]) r = (out.choices[0].message || {}).content;
  if (r === undefined) r = out;
  return typeof r === "string" ? r : JSON.stringify(r);
}

function ttJson(text) {
  const t = String(text || "").replace(/```(json)?/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const d = JSON.parse(t.slice(a, b + 1)); return d && Array.isArray(d.tage) ? d : (d && Array.isArray(d.acts) ? { tage: [{ label: "", acts: d.acts }] } : null); } catch (e) { return null; }
}

async function aiRpc(env, token, name, body) {
  const r = await fetch(baseUrl(env.SUPABASE_URL) + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: String(env.SUPABASE_ANON_KEY || "").trim(), Authorization: "Bearer " + token },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) return null;
  return Number(await r.json());
}

async function timetable(request, env, cors) {
  const me = await whoami(request, env);
  if (!env.AI) return json({ error: "D-20" }, 501, cors);
  const body = await request.json().catch(() => ({}));
  /* Sperre: die kleinere von Chronik-Grenze (aiPerDay) und TT_MAX_DAY.
     Beide 0/leer = keine Sperre. */
  const ausChronik = Math.max(0, Math.floor(Number(body.grenze) || 0));
  const fest = Math.max(0, Math.floor(Number(env.TT_MAX_DAY) || 0));
  const grenze = fest && ausChronik ? Math.min(fest, ausChronik) : (fest || ausChronik);
  let versuche = 0;
  if (grenze) {
    const heute = await aiRpc(env, me.token, "ai_today");
    if (heute === null || !isFinite(heute)) return json({ error: "D-25" }, 503, cors);
    if (heute >= grenze) return json({ error: "D-24", detail: heute + "/" + grenze }, 429, cors);
  }
  const zaehlen = async () => { if (grenze && versuche) await aiRpc(env, me.token, "ai_bump", { p_calls: versuche }); };
  const bild = String(body.bild || "");
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(bild) || bild.length > 6000000) return json({ error: "D-08" }, 400, cors);
  const modelle = [env.TT_MODEL, "@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/mistralai/mistral-small-3.1-24b-instruct", "@cf/google/gemma-3-12b-it", "@cf/meta/llama-3.2-11b-vision-instruct"].filter(Boolean);
  if (grenze) modelle.splice(2);
  const fehler = [];
  let bytes = null;
  for (const m of modelle) {
    versuche++;
    try {
      let out;
      if (/llama-3\.2/.test(m)) {
        if (!bytes) { const roh = atob(bild.split(",")[1]); bytes = new Array(roh.length); for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i); }
        const run = () => env.AI.run(m, { prompt: TT_PROMPT, image: bytes, max_tokens: 4096 });
        try { out = await run(); }
        catch (e) {
          if (/agree|licen/i.test(String((e && e.message) || ""))) { await env.AI.run(m, { prompt: "agree" }); out = await run(); } else throw e;
        }
      } else {
        out = await env.AI.run(m, {
          messages: [
            { role: "system", content: "You extract timetables from images and answer with JSON only." },
            { role: "user", content: [{ type: "text", text: TT_PROMPT }, { type: "image_url", image_url: { url: bild } }] }
          ],
          max_tokens: 4096, temperature: 0.1
        });
      }
      const d = ttJson(ttText(out));
      if (d) { await zaehlen(); return json({ ok: true, tage: d.tage, modell: m.split("/").pop() }, 200, cors); }
      fehler.push(m.split("/").pop() + ": " + ttText(out).slice(0, 80));
    } catch (e) { fehler.push(m.split("/").pop() + ": " + String((e && e.message) || e).slice(0, 120)); }
  }
  await zaehlen();
  return json({ error: "D-21", detail: fehler.join(" | ").slice(0, 600) }, 502, cors);
}
