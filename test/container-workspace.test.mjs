import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDirectory = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const renderCompose = async (environment = {}, { setupProfile = true } = {}) => {
  const args = ["compose"];
  if (setupProfile) args.push("--profile", "setup", "--profile", "runtime");
  args.push("--env-file", "/dev/null", "config", "--format", "json");
  const { stdout } = await execFileAsync(
    "docker",
    args,
    {
      cwd: projectDirectory,
      env: {
        ...process.env,
        HOST_BIND_ADDRESS: "",
        PUBLIC_HOST: "",
        WEB_INSTALLER_SETUP_TOKEN: "",
        ...environment,
      },
    },
  );
  return JSON.parse(stdout);
};

test("default Compose topology cannot start both host-port owners", async () => {
  const config = await renderCompose({}, { setupProfile: false });

  assert.equal(config.services.installer, undefined);
  assert.equal(config.services.crm, undefined);
  assert.deepEqual(Object.keys(config.services), ["crm-workspace-init"]);
});

test("Compose shares a named CRM volume without exposing installer secrets", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /crm-workspace-init:/u);
  assert.match(compose, /crm-source:\/workspace\/crm/u);
  assert.doesNotMatch(compose, /\.\/crm:\/workspace\/crm/u);
  assert.match(compose, /CRM_WORKSPACE_DIR:\s*["']?\/workspace\/crm/u);
  assert.match(compose, /chown -R 1000:1000 \/workspace\/crm/u);
  const installer = compose.match(/  installer:[\s\S]*?(?=\n  crm:)/u)?.[0] || "";
  const crm = compose.match(/  crm:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\nvolumes:)/u)?.[0] || "";
  const diagnostics = compose.match(/  diagnostics:[\s\S]*?(?=\n  [a-zA-Z0-9_-]+:|\nvolumes:)/u)?.[0] || "";
  assert.match(installer, /user:\s*["']1000:1000["']/u);
  assert.match(crm, /user:\s*["']1000:1000["']/u);
  assert.match(diagnostics, /user:\s*["']1000:1000["']/u);
  assert.match(installer, /installer-data:\/data/u);
  assert.doesNotMatch(crm, /installer-data|:\/data/u);
  assert.match(crm, /crm-source:\/workspace\/crm/u);
  assert.match(diagnostics, /installer-data:\/data:ro/u);
  assert.doesNotMatch(diagnostics, /crm-source/u);
  assert.match(installer, /\$\{HOST_BIND_ADDRESS:-127\.0\.0\.1\}:3300:7359/u);
  assert.match(crm, /\$\{HOST_BIND_ADDRESS:-127\.0\.0\.1\}:3300:3000/u);
  assert.match(installer, /CRM_PUBLIC_URL_DEFAULT:\s*["']http:\/\/\$\{PUBLIC_HOST:-localhost\}:3300["']/u);
  assert.match(installer, /WEB_INSTALLER_ALLOWED_ORIGINS:\s*["']http:\/\/\$\{PUBLIC_HOST:-localhost\}:3300["']/u);
  assert.match(installer, /profiles:\s*\n\s+- setup/u);
  assert.match(installer, /restart:\s*["']no["']/u);
  assert.doesNotMatch(compose, /CRM_PORT/u);
  assert.match(crm, /restart:\s*unless-stopped/u);
  assert.match(crm, /init:\s*true/u);
  assert.doesNotMatch(compose, /HOST_UID|HOST_GID/u);
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.match(compose, /condition:\s*service_completed_successfully/u);
  assert.match(compose, /crm-source:\s*$/mu);
});

test("the installer image prepares the workspace parent and remains non-root", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /mkdir -p[^\n]*\/workspace/u);
  assert.match(dockerfile, /^USER\s+node$/mu);
  assert.doesNotMatch(dockerfile, /^USER\s+root$/mu);
  assert.doesNotMatch(dockerfile, /^VOLUME\s+.*\/data/mu);
  assert.match(dockerfile, /^EXPOSE\s+7359\s+3000$/mu);
  assert.match(dockerfile, /^CMD \["node", "scripts\/container\/start-installer\.mjs"\]$/mu);
  assert.doesNotMatch(dockerfile, /npm\s+(ci|install)|npm\s+run\s+build/u);
});

test("only the bounded volume initializer runs as root", async () => {
  const config = await renderCompose({ CRM_PORT: "3000" });
  assert.equal(config.services["crm-workspace-init"].user, "0:0");
  assert.equal(config.services.installer.user, "1000:1000");
  assert.equal(config.services.crm.user, "1000:1000");
  assert.equal(config.services.crm.depends_on["crm-workspace-init"].condition, "service_completed_successfully");
  assert.deepEqual(
    Object.entries(config.services).filter(([, service]) => service.user === "0:0").map(([name]) => name),
    ["crm-workspace-init"],
  );
  assert.deepEqual(Object.keys(config.volumes).sort(), ["crm-source", "installer-data"]);
  assert.deepEqual(config.services.crm.volumes, [{
    type: "volume",
    source: "crm-source",
    target: "/workspace/crm",
    volume: {},
  }]);
  assert.deepEqual(config.services["crm-workspace-init"].volumes, config.services.crm.volumes);
  assert.equal(config.services.installer.volumes.filter((volume) => volume.source === "crm-source").length, 1);
  assert.equal(config.services.installer.volumes.some((volume) => volume.source === "installer-data" && volume.target === "/data"), true);
  assert.deepEqual(config.services.installer.ports, [{
    mode: "ingress",
    host_ip: "127.0.0.1",
    target: 7359,
    published: "3300",
    protocol: "tcp",
  }]);
  assert.deepEqual(config.services.crm.ports, [{
    mode: "ingress",
    host_ip: "127.0.0.1",
    target: 3000,
    published: "3300",
    protocol: "tcp",
  }]);
  assert.equal(config.services.installer.environment.CRM_PUBLIC_URL_DEFAULT, "http://localhost:3300");
  assert.equal(config.services.installer.environment.WEB_INSTALLER_ALLOWED_ORIGINS, "http://localhost:3300");
  assert.deepEqual(config.services.installer.profiles, ["setup"]);
  assert.equal(config.services.installer.restart, "no");
  assert.deepEqual(config.services.crm.profiles, ["runtime"]);
  assert.equal(config.services.crm.healthcheck.start_period, "20m0s");
  assert.match(config.services.crm.healthcheck.test.join(" "), /http:\/\/127\.0\.0\.1:3000\//u);
});

test("Compose healthchecks explicitly exit for successful and failed responses", async () => {
  const config = await renderCompose();

  assert.deepEqual(config.services.installer.healthcheck.test, [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:7359/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ]);
  assert.deepEqual(config.services.crm.healthcheck.test, [
    "CMD",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ]);
});

test("Compose binds both publications only to the configured LAN interface", async () => {
  const config = await renderCompose({
    CRM_PORT: "3000",
    HOST_BIND_ADDRESS: "192.168.9.45",
    PUBLIC_HOST: "192.168.9.45",
  });

  assert.deepEqual(config.services.installer.ports, [{
    mode: "ingress",
    host_ip: "192.168.9.45",
    target: 7359,
    published: "3300",
    protocol: "tcp",
  }]);
  assert.deepEqual(config.services.crm.ports, [{
    mode: "ingress",
    host_ip: "192.168.9.45",
    target: 3000,
    published: "3300",
    protocol: "tcp",
  }]);
  assert.equal(config.services.installer.environment.CRM_PUBLIC_URL_DEFAULT, "http://192.168.9.45:3300");
  assert.equal(config.services.installer.environment.WEB_INSTALLER_ALLOWED_ORIGINS, "http://192.168.9.45:3300");
});

test("the local CLI keeps port 3000 as its default site URL", async () => {
  const cli = await readFile(new URL("../scripts/paso1-supabase.mjs", import.meta.url), "utf8");

  assert.match(cli, /const siteUrl = publicUrl \|\| "http:\/\/localhost:3000";/u);
  assert.doesNotMatch(cli, /const siteUrl = publicUrl \|\| "http:\/\/localhost:3300";/u);
});
