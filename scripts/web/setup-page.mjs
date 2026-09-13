const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

export const renderSetupPage = ({ nonce }) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Acceso inicial · Instalador CRM</title>
  <style nonce="${escapeHtml(nonce)}">
    :root { color-scheme:light; --ink:#17211b; --muted:#526158; --paper:#f4f1e8; --card:#fffdf7; --line:#858a82; --green:#176b4d; --green-dark:#0e4935; --error:#9d2f25; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; padding:1rem; color:var(--ink); background:var(--paper); font-family:"Avenir Next","Segoe UI",sans-serif; }
    main { width:min(100%, 30rem); padding:clamp(1.5rem,5vw,2.5rem); border:1px solid #c8c5b9; border-radius:1.25rem; background:var(--card); box-shadow:0 1.5rem 4rem rgba(34,47,39,.09); }
    .eyebrow { margin:0 0 .8rem; color:var(--green); font-size:.75rem; font-weight:800; letter-spacing:.15em; text-transform:uppercase; }
    h1 { margin:0; font-family:Georgia,"Times New Roman",serif; font-size:clamp(2rem,8vw,3.5rem); font-weight:500; line-height:1; letter-spacing:-.035em; }
    .intro { margin:1rem 0 1.5rem; color:var(--muted); line-height:1.6; }
    label { display:block; margin-bottom:.55rem; font-weight:800; }
    input { width:100%; min-height:44px; border:1px solid var(--line); border-radius:.65rem; padding:.85rem .95rem; color:var(--ink); background:#fff; font:inherit; }
    input:focus { outline:3px solid var(--green); outline-offset:2px; border-color:var(--green); }
    button { width:100%; min-height:44px; margin-top:1rem; border:0; border-radius:.65rem; padding:.9rem 1.2rem; color:#fff; background:var(--green); font:inherit; font-weight:800; cursor:pointer; }
    button:hover { background:var(--green-dark); }
    button:focus-visible { outline:3px solid var(--green); outline-offset:3px; }
    button:disabled { cursor:wait; opacity:.68; }
    #result { min-height:1.5rem; margin:1rem 0 0; color:var(--error); font-weight:700; line-height:1.5; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior:auto !important; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Acceso inicial</p>
    <h1>Ingresá el token de configuración.</h1>
    <p class="intro">Buscalo en <code>WEB_INSTALLER_SETUP_TOKEN</code> dentro del archivo <code>.env</code>. Si esa variable no fue configurada, el instalador lo muestra al arrancar debajo de «🔐 Token de configuración de un solo uso»; con Docker aparece en los logs del servicio <code>installer</code>. Se acepta una sola vez y después esta sesión queda autorizada.</p>
    <form id="setup-form">
      <label for="setup-token">Token de configuración</label>
      <input id="setup-token" name="setupToken" type="password" required autocomplete="one-time-code" spellcheck="false">
      <button type="submit">Continuar</button>
    </form>
    <p id="result" role="alert" aria-live="assertive"></p>
  </main>
  <script nonce="${escapeHtml(nonce)}">
    const form = document.querySelector("#setup-form");
    const tokenInput = document.querySelector("#setup-token");
    const button = form.querySelector("button");
    const result = document.querySelector("#result");

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      result.textContent = "";
      try {
        const response = await fetch("/api/setup/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setupToken: tokenInput.value }),
        });
        tokenInput.value = "";
        if (response.ok) {
          location.reload();
          return;
        }
        result.textContent = "El token no es válido o ya fue utilizado.";
      } catch {
        result.textContent = "No pude comunicarme con el instalador. Volvé a intentarlo.";
      } finally {
        button.disabled = false;
        tokenInput.focus();
      }
    });
  </script>
</body>
</html>`;
