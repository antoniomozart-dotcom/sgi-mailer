const express = require("express");
const cors    = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

/* ── CORS: só aceita chamadas do seu domínio ── */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    /* Permite chamadas sem origin (ex: Postman, curl) apenas em dev */
    if (!origin) return cb(null, process.env.NODE_ENV !== "production");
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error("Origem não permitida: " + origin));
  }
}));

/* ── Cliente Supabase com service_role ── */
function getAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

/* ── Validação simples de e-mail ── */
function emailValido(e) {
  return typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

/* ══════════════════════════════════════════════
   POST /enviar-reset
   Body: { email, redirectTo? }
   Envia e-mail de redefinição/criação de senha.
   Usa resetPasswordForEmail (usuário já existe no Auth).
══════════════════════════════════════════════ */
app.post("/enviar-reset", async (req, res) => {
  try {
    const { email, redirectTo } = req.body || {};
    if (!emailValido(email)) {
      return res.status(400).json({ ok: false, error: "E-mail inválido." });
    }

    const admin    = getAdmin();
    const redirect = redirectTo || process.env.REDIRECT_URL || "https://www.sgirenovar.com.br/login.html";

    const { error } = await admin.auth.resetPasswordForEmail(email, {
      redirectTo: redirect
    });

    if (error) throw error;

    console.log(`[reset] E-mail de reset enviado para ${email}`);
    return res.json({ ok: true, message: `E-mail enviado para ${email}.` });

  } catch (e) {
    console.error("[reset] Erro:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ══════════════════════════════════════════════
   POST /convidar
   Body: { email, nome?, perfil?, redirectTo? }
   Cria usuário no Supabase Auth (se não existir)
   e envia e-mail de convite/boas-vindas.
   Usa inviteUserByEmail — ideal para novos usuários.
══════════════════════════════════════════════ */
app.post("/convidar", async (req, res) => {
  try {
    const { email, nome, redirectTo } = req.body || {};
    if (!emailValido(email)) {
      return res.status(400).json({ ok: false, error: "E-mail inválido." });
    }

    const admin    = getAdmin();
    const redirect = redirectTo || process.env.REDIRECT_URL || "https://www.sgirenovar.com.br/login.html";

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirect,
      data: { nome: nome || null }
    });

    if (error) throw error;

    console.log(`[convite] Convite enviado para ${email} (uid: ${data?.user?.id})`);
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
