const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

export const renderConnectionPage = ({
  automaticCrmStart = false,
  csrfToken,
  defaultPublicUrl = "http://localhost:3000",
  nonce,
}) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${escapeHtml(csrfToken)}">
  <title>Configurar Supabase · Instalador CRM</title>
  <style nonce="${escapeHtml(nonce)}">
    :root { color-scheme:light; --ink:#17211b; --muted:#526158; --paper:#f4f1e8; --card:#fffdf7; --line:#c8c5b9; --green:#176b4d; --green-dark:#0e4935; --error:#9d2f25; --warm:#8a6112; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); background:var(--paper); font-family:"Avenir Next","Segoe UI",sans-serif; }
    body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.3; background-image:linear-gradient(rgba(23,33,27,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(23,33,27,.035) 1px,transparent 1px); background-size:28px 28px; }
    main { position:relative; width:min(100% - 2rem,72rem); margin:auto; padding:clamp(2rem,6vw,5rem) 0; }
    header { display:grid; grid-template-columns:minmax(0,.8fr) minmax(20rem,1.2fr); gap:clamp(2rem,7vw,6rem); align-items:end; margin-bottom:2rem; }
    .eyebrow { margin:0 0 1rem; color:var(--green); font-size:.75rem; font-weight:800; letter-spacing:.15em; text-transform:uppercase; }
    h1 { margin:0; max-width:12ch; font-family:Georgia,"Times New Roman",serif; font-size:clamp(2.5rem,6vw,5rem); font-weight:500; line-height:.94; letter-spacing:-.045em; }
    .intro { margin:0; max-width:40rem; color:var(--muted); font-size:1.05rem; line-height:1.65; }
    .steps { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
    .panel { padding:clamp(1.35rem,3vw,2.25rem); border:1px solid var(--line); border-radius:1.25rem; background:var(--card); box-shadow:0 1.5rem 4rem rgba(34,47,39,.08); }
    .panel h2 { margin-top:0; }
    .field + .field, fieldset + .field, .choice-fields { margin-top:1.15rem; }
    label, legend { display:block; margin-bottom:.5rem; font-weight:800; }
    input, select { width:100%; min-height:44px; border:1px solid #737a72; border-radius:.65rem; background:#fff; color:var(--ink); padding:.75rem .9rem; font:inherit; }
    input:focus, select:focus { outline:3px solid var(--green); outline-offset:2px; border-color:var(--green); }
    fieldset { margin:0; padding:0; border:0; }
    .radio { display:flex; gap:.6rem; align-items:center; min-height:36px; margin:.25rem 0; font-weight:600; }
    .radio input { width:1.2rem; min-height:1.2rem; margin:0; }
    .help { margin:.4rem 0 0; color:var(--muted); font-size:.86rem; line-height:1.5; }
    a { color:var(--green-dark); font-weight:700; text-underline-offset:.2em; }
    button { width:100%; min-height:44px; margin-top:1.4rem; border:0; border-radius:.65rem; padding:.85rem 1.1rem; color:#fff; background:var(--green); font:inherit; font-weight:800; cursor:pointer; transition:transform .16s ease,background .16s ease; }
    button:hover { transform:translateY(-1px); background:var(--green-dark); }
    button:focus-visible { outline:3px solid var(--green); outline-offset:3px; }
    button:disabled { cursor:wait; opacity:.68; transform:none; }
    .result { min-height:3rem; margin:1rem 0 0; padding:.8rem 0 0; border-top:1px solid var(--line); line-height:1.5; }
    .result[data-state="success"] { color:var(--green-dark); font-weight:700; }
    .result[data-state="error"] { color:var(--error); font-weight:700; }
    .boundary { margin:1.25rem 0 0; padding-left:1rem; border-left:3px solid #d4a72c; color:var(--muted); font-size:.88rem; line-height:1.55; }
    .summary { padding:1rem; border-radius:.7rem; background:#f3efe2; color:var(--muted); line-height:1.55; }
    [hidden] { display:none !important; }
    @media (max-width:800px) { header,.steps { grid-template-columns:1fr; } h1 { max-width:14ch; } }
    @media (prefers-reduced-motion:reduce) { * { transition:none !important; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Instalador local · Supabase</p>
        <h1>Tu CRM, preparado desde acá.</h1>
      </div>
      <p class="intro">Primero validamos tu cuenta. Después elegís un proyecto y el instalador clona tu fork, aplica las migraciones, configura Auth y escribe <strong>crm/.env.local</strong> sin mostrar secretos.</p>
    </header>

    <div class="steps">
      <section class="panel" aria-labelledby="connection-title">
        <h2 id="connection-title">1. Conectar Supabase</h2>
        <form id="connection-form">
          <div class="field">
            <label for="supabase-access-token">Personal Access Token</label>
            <input id="supabase-access-token" name="supabaseAccessToken" type="password" required autocomplete="off" spellcheck="false" aria-describedby="token-help">
            <p class="help" id="token-help">Crealo en <a href="https://supabase.com/dashboard/account/tokens" target="_blank" rel="noreferrer">Supabase → Account → Access Tokens</a>. Tiene que empezar con <strong>sbp_</strong>.</p>
          </div>
          <div class="field">
            <label for="supabase-project-ref">Project Ref <span class="help">(opcional)</span></label>
            <input id="supabase-project-ref" name="supabaseProjectRef" type="text" autocomplete="off" spellcheck="false" maxlength="20" pattern="[a-z0-9]{20}" aria-describedby="ref-help">
            <p class="help" id="ref-help">Si ya sabés qué proyecto usar, podés dejarlo seleccionado desde esta conexión.</p>
          </div>
          <button type="submit">Validar y guardar</button>
        </form>
        <p id="connection-result" class="result" aria-live="polite"></p>
        <p class="boundary">Al validar la conexión todavía no crea el proyecto ni aplica migraciones: eso empieza cuando confirmás el paso 2.</p>
      </section>

      <section id="setup-panel" class="panel" aria-labelledby="setup-title" hidden>
        <h2 id="setup-title">2. Preparar el CRM</h2>
        <p class="summary">${automaticCrmStart
          ? "Este paso prepara el código dentro de Docker, espera una base saludable y aplica cada migración una sola vez. Cuando termina, el CRM se construye y arranca automáticamente."
          : "Este paso prepara el código en <strong>./crm</strong>, espera una base saludable y aplica cada migración una sola vez. Al terminar, ejecutá <strong>npm run levantar</strong>."}</p>
        <form id="setup-form">
          <fieldset>
            <legend>¿Qué querés hacer?</legend>
            <label class="radio"><input type="radio" name="mode" value="existing" checked> Usar un proyecto existente</label>
            <label class="radio"><input type="radio" name="mode" value="create"> Crear un proyecto nuevo</label>
          </fieldset>

          <div id="existing-fields" class="choice-fields">
            <label for="existing-project">Proyecto</label>
            <select id="existing-project" required></select>
          </div>

          <div id="create-fields" class="choice-fields" hidden>
            <div class="field">
              <label for="organization">Organización</label>
              <select id="organization"></select>
            </div>
            <div class="field">
              <label for="project-name">Nombre del proyecto</label>
              <input id="project-name" value="crm-whatsapp" minlength="2" maxlength="100">
            </div>
            <div class="field">
              <label for="region">Región</label>
              <input id="region" value="sa-east-1" pattern="[a-z]{2,3}-[a-z]+-[0-9]" aria-describedby="region-help">
              <p class="help" id="region-help">São Paulo es la opción más cercana para el cono sur.</p>
            </div>
          </div>

          <div class="field">
            <label for="public-url">URL del CRM</label>
            <input id="public-url" type="url" value="${escapeHtml(defaultPublicUrl)}" required aria-describedby="url-help">
            <p class="help" id="url-help">Usá localhost para probar, la URL del túnel o tu dominio HTTPS estable.</p>
          </div>
          <button id="setup-button" type="submit">Preparar Supabase y el CRM</button>
        </form>
        <p id="setup-result" class="result" aria-live="polite"></p>
      </section>
    </div>
  </main>
  <script nonce="${escapeHtml(nonce)}">
    const csrfToken = document.querySelector('meta[name="csrf-token"]').content;
    const connectionForm = document.querySelector("#connection-form");
    const tokenInput = document.querySelector("#supabase-access-token");
    const connectionResult = document.querySelector("#connection-result");
    const setupPanel = document.querySelector("#setup-panel");
    const setupForm = document.querySelector("#setup-form");
    const setupResult = document.querySelector("#setup-result");
    const setupButton = document.querySelector("#setup-button");
    const existingSelect = document.querySelector("#existing-project");
    const organizationSelect = document.querySelector("#organization");
    const automaticCrmStart = ${JSON.stringify(automaticCrmStart)};

    const request = async (url, options = {}) => {
      const response = await fetch(url, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "La solicitud no pudo completarse.");
      return data;
    };

    const createRequestId = () => {
      const webCrypto = globalThis.crypto;
      try {
        if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
        if (typeof webCrypto?.getRandomValues !== "function") throw new Error();
        const bytes = webCrypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
      } catch {
        throw new Error("Tu navegador no pudo crear un identificador seguro. Actualizalo o probá con otro navegador y volvé a intentar.");
      }
    };

    const addOption = (select, value, label) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.append(option);
    };

    const loadOptions = async () => {
      const data = await request("/api/supabase/options");
      existingSelect.replaceChildren();
      organizationSelect.replaceChildren();
      for (const project of data.projects) addOption(existingSelect, project.ref, project.name + " · " + project.region + " · " + project.status);
      for (const organization of data.organizations) addOption(organizationSelect, organization.slug, organization.name);
      const preferredRef = document.querySelector("#supabase-project-ref").value.trim();
      if (preferredRef && [...existingSelect.options].some((option) => option.value === preferredRef)) existingSelect.value = preferredRef;
      setupPanel.hidden = false;
      const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
      setupPanel.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    };

    connectionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = connectionForm.querySelector("button");
      button.disabled = true;
      connectionResult.dataset.state = "";
      connectionResult.textContent = "Validando con Supabase…";
      try {
        const data = await request("/api/supabase/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify({
            supabaseAccessToken: tokenInput.value,
            supabaseProjectRef: document.querySelector("#supabase-project-ref").value,
          }),
        });
        connectionResult.dataset.state = "success";
        connectionResult.textContent = data.message;
        await loadOptions();
      } catch (error) {
        connectionResult.dataset.state = "error";
        connectionResult.textContent = error.message;
      } finally {
        tokenInput.value = "";
        button.disabled = false;
      }
    });

    const selectMode = () => {
      const creating = setupForm.elements.mode.value === "create";
      document.querySelector("#existing-fields").hidden = creating;
      document.querySelector("#create-fields").hidden = !creating;
      existingSelect.required = !creating;
      organizationSelect.required = creating;
      document.querySelector("#project-name").required = creating;
      document.querySelector("#region").required = creating;
    };
    setupForm.addEventListener("change", (event) => { if (event.target.name === "mode") selectMode(); });

    const waitForCrm = async () => {
      setupResult.textContent = "Todo quedó guardado. Este mismo enlace está cambiando al CRM; puede tardar unos minutos la primera vez.";
      for (;;) {
        try {
          const response = await fetch("/healthz", { cache: "no-store" });
          if (response.headers.get("x-crm-installer") !== "1") {
            globalThis.location.assign("/login");
            return;
          }
        } catch {
          // The shared port is briefly unavailable between both containers.
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    const pollJob = async (statusUrl) => {
      for (;;) {
        const data = await request(statusUrl);
        const job = data.job;
        setupResult.textContent = job.progress.message;
        if (job.status === "succeeded") {
          setupResult.dataset.state = "success";
          setupResult.textContent = ${JSON.stringify(automaticCrmStart
            ? `Supabase quedó listo. Docker va a iniciar el CRM en este mismo enlace: ${defaultPublicUrl}. Meta se conecta en el paso siguiente.`
            : "Supabase y crm/.env.local quedaron listos. Ejecutá npm run levantar para iniciar el CRM; Meta se conecta en el paso siguiente.")};
          if (automaticCrmStart) await waitForCrm();
          return;
        }
        if (["failed", "interrupted", "needs_attention"].includes(job.status)) {
          setupResult.dataset.state = "error";
          setupResult.textContent = job.error?.message || "La configuración no pudo terminar.";
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    setupForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      setupButton.disabled = true;
      setupResult.dataset.state = "";
      setupResult.textContent = "Creando el trabajo de configuración…";
      try {
        const mode = setupForm.elements.mode.value;
        const body = {
          mode,
          publicUrl: document.querySelector("#public-url").value,
          requestId: createRequestId(),
        };
        if (mode === "existing") body.ref = existingSelect.value;
        else Object.assign(body, {
          organizationSlug: organizationSelect.value,
          name: document.querySelector("#project-name").value,
          region: document.querySelector("#region").value,
        });
        const data = await request("/api/supabase/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
          body: JSON.stringify(body),
        });
        await pollJob(data.job.statusUrl);
      } catch (error) {
        setupResult.dataset.state = "error";
        setupResult.textContent = error.message;
      } finally {
        setupButton.disabled = false;
      }
    });
  </script>
</body>
</html>`;
