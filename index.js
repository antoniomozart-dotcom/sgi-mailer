const express = require("express");
const cors    = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

/* ── CORS ── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("Origem não permitida: " + origin));
  }
}));

/* ── Supabase Admin ── */
function getAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/* ── Resend ── */
async function enviarEmailResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY não configurada.");
  const from = process.env.EMAIL_FROM || "SGI Renovar <noreply@sgirenovar.com.br>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || JSON.stringify(data));
  return data;
}

/* ── Validação de e-mail ── */
function emailValido(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

/* ── Template de e-mail ── */
function templateEmail({ titulo, subtitulo, mensagem, link, labelBotao }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
      <div style="margin-bottom:24px">
        <span style="font-size:22px;font-weight:bold;color:#1f6340">SGI Renovar</span>
      </div>
      <h2 style="color:#0d2218;font-size:20px;margin-bottom:12px">${titulo}</h2>
      ${subtitulo ? `<p style="color:#3d5e4a;font-size:13px;margin-bottom:8px">${subtitulo}</p>` : ""}
      <p style="color:#3d5e4a;font-size:15px;line-height:1.7;margin-bottom:24px">${mensagem}</p>
      <a href="${link}" style="display:inline-block;background:#1f6340;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600">
        ${labelBotao}
      </a>
      <p style="color:#7a9585;font-size:12px;line-height:1.6;margin-top:28px">
        Este link expira em 24 horas. Se você não solicitou este e-mail, pode ignorá-lo.<br><br>
        <a href="${link}" style="color:#7a9585;word-break:break-all">${link}</a>
      </p>
      <hr style="border:none;border-top:1px solid #d4e7db;margin:24px 0">
      <p style="color:#7a9585;font-size:11px">SGI Renovar · Sistema de Gestão Integrada</p>
    </div>
  `;
}

/* ══════════════════════════════════════════════
   POST /enviar-reset
   - Se usuário existe no Auth → link recovery
   - Se não existe → link invite (cria a conta)
══════════════════════════════════════════════ */
app.post("/enviar-reset", async (req, res) => {
  try {
    const { email, nome, redirectTo } = req.body || {};
    if (!emailValido(email)) return res.status(400).json({ ok: false, error: "E-mail inválido." });

    const admin    = getAdmin();
    const redirect = redirectTo || process.env.REDIRECT_URL || "https://www.sgirenovar.com.br/login.html";

    /* Verifica se usuário existe no Auth */
    const { data: lista, error: listErr } = await admin.auth.admin.listUsers();
    if (listErr) throw listErr;

    const existeNoAuth = lista?.users?.some(u => u.email === email.trim().toLowerCase());

    let link, tipo;

    if (existeNoAuth) {
      /* Usuário já tem conta → reset de senha */
      const { data, error } = await admin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo: redirect }
      });
      if (error) throw error;
      link = data?.properties?.action_link || data?.action_link;
      tipo = "recovery";
    } else {
      /* Usuário ainda não tem conta no Auth → convite */
      const { data, error } = await admin.auth.admin.generateLink({
        type: "invite",
        email,
        options: { redirectTo: redirect, data: { nome: nome || null } }
      });
      if (error) throw error;
      link = data?.properties?.action_link || data?.action_link;
      tipo = "invite";
    }

    if (!link) throw new Error("Link não gerado pelo Supabase.");

    const nomeDisplay = nome ? `, ${nome.split(" ")[0]}` : "";

    await enviarEmailResend({
      to: email,
      subject: tipo === "invite"
        ? "SGI Renovar — Seu acesso foi criado"
        : "SGI Renovar — Defina sua senha de acesso",
      html: templateEmail(tipo === "invite" ? {
        titulo:     `Bem-vindo${nomeDisplay}!`,
        mensagem:   `Seu acesso ao <strong>SGI Renovar</strong> foi criado. Clique no botão abaixo para definir sua senha e entrar no sistema.`,
        link,
        labelBotao: "Ativar meu acesso"
      } : {
        titulo:     "Defina sua senha de acesso",
        mensagem:   `Clique no botão abaixo para criar ou redefinir sua senha no <strong>SGI Renovar</strong>.`,
        link,
        labelBotao: "Definir minha senha"
      })
    });

    console.log(`[reset/${tipo}] E-mail enviado para ${email}`);
    return res.json({ ok: true, message: `E-mail enviado para ${email}.`, tipo });

  } catch (e) {
    console.error("[reset] Erro:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════════════════════════════════
   POST /convidar
   Cria usuário no Auth e envia convite pelo Resend
══════════════════════════════════════════════ */
app.post("/convidar", async (req, res) => {
  try {
    const { email, nome, redirectTo } = req.body || {};
    if (!emailValido(email)) return res.status(400).json({ ok: false, error: "E-mail inválido." });

    const admin    = getAdmin();
    const redirect = redirectTo || process.env.REDIRECT_URL || "https://www.sgirenovar.com.br/login.html";

    const { data, error } = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { redirectTo: redirect, data: { nome: nome || null } }
    });
    if (error) throw error;

    const link = data?.properties?.action_link || data?.action_link;
    if (!link) throw new Error("Link de convite não gerado.");

    const nomeDisplay = nome ? `, ${nome.split(" ")[0]}` : "";

    await enviarEmailResend({
      to: email,
      subject: "SGI Renovar — Seu acesso foi criado",
      html: templateEmail({
        titulo:     `Bem-vindo${nomeDisplay}!`,
        mensagem:   `Seu acesso ao <strong>SGI Renovar</strong> foi criado. Clique no botão abaixo para definir sua senha e entrar no sistema.`,
        link,
        labelBotao: "Ativar meu acesso"
      })
    });

    console.log(`[convite] E-mail enviado para ${email} (uid: ${data?.user?.id})`);
    return res.json({ ok: true, message: `Convite enviado para ${email}.`, uid: data?.user?.id });

  } catch (e) {
    console.error("[convite] Erro:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── Health check ── */
app.get("/health", (_, res) => res.json({ ok: true, service: "sgi-mailer" }));

/* ── 404 ── */
app.use((_, res) => res.status(404).json({ ok: false, error: "Rota não encontrada." }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`sgi-mailer rodando na porta ${PORT}`));
