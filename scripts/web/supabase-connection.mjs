import { SupabaseAdmin } from "../lib/supabase.mjs";
import { EncryptedCredentialStore } from "./encrypted-store.mjs";

const TOKEN_MAX_LENGTH = 4096;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;

export class InputValidationError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = "InputValidationError";
    this.publicMessage = publicMessage;
    this.statusCode = 400;
  }
}

export class ConnectionError extends Error {
  constructor(publicMessage, statusCode = 502, options) {
    super(publicMessage, options);
    this.name = "ConnectionError";
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
  }
}

export const validateConnectionInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InputValidationError("La solicitud no tiene un formato válido.");
  }

  const token = typeof input.supabaseAccessToken === "string"
    ? input.supabaseAccessToken.trim()
    : "";
  if (!/^sbp_[A-Za-z0-9_-]+$/u.test(token) || token.length > TOKEN_MAX_LENGTH) {
    throw new InputValidationError(
      "Pegá un Personal Access Token válido de Supabase. Tiene que empezar con sbp_.",
    );
  }

  const rawProjectRef = input.supabaseProjectRef;
  if (rawProjectRef !== undefined && rawProjectRef !== null && typeof rawProjectRef !== "string") {
    throw new InputValidationError("El Project Ref tiene que ser texto o quedar vacío.");
  }
  const projectRef = typeof rawProjectRef === "string" ? rawProjectRef.trim() : "";
  if (projectRef && !PROJECT_REF_PATTERN.test(projectRef)) {
    throw new InputValidationError(
      "El Project Ref tiene que tener 20 letras minúsculas o números. Revisalo en Supabase.",
    );
  }

  return { supabaseAccessToken: token, supabaseProjectRef: projectRef };
};

const organizationFailure = (response) => {
  if (response?.status === 401 || response?.status === 403) {
    return new ConnectionError(
      "Supabase rechazó el token. Generá uno nuevo en Account → Access Tokens y volvé a intentar.",
      401,
    );
  }
  return new ConnectionError(
    "No pude consultar Supabase. Revisá tu conexión a internet y volvé a intentar.",
    502,
  );
};

export const connectSupabase = async (
  input,
  {
    createAdmin = (token) => new SupabaseAdmin(token),
    store = new EncryptedCredentialStore(),
  } = {},
) => {
  const credentials = validateConnectionInput(input);
  const admin = createAdmin(credentials.supabaseAccessToken);
  const organizations = await admin.organizaciones();
  if (!organizations?.ok) throw organizationFailure(organizations);

  let project = null;
  if (credentials.supabaseProjectRef) {
    const response = await admin.proyecto(credentials.supabaseProjectRef);
    if (!response?.ok) {
      throw new ConnectionError(
        "El token funciona, pero no pude abrir ese proyecto. Revisá el Project Ref o dejalo vacío.",
        422,
      );
    }
    project = {
      ref: credentials.supabaseProjectRef,
      name: typeof response.json?.name === "string" ? response.json.name : "",
      status: typeof response.json?.status === "string" ? response.json.status : "UNKNOWN",
      region: typeof response.json?.region === "string" ? response.json.region : "",
    };
  }

  try {
    const update = typeof store.update === "function" ? store.update.bind(store) : store.save.bind(store);
    await update({
      supabaseAccessToken: credentials.supabaseAccessToken,
      ...(credentials.supabaseProjectRef
        ? { supabaseProjectRef: credentials.supabaseProjectRef }
        : {}),
    });
  } catch (error) {
    throw new ConnectionError(
      "La conexión funciona, pero no pude guardar las credenciales cifradas. Revisá los permisos de esta carpeta.",
      500,
      { cause: error },
    );
  }

  return {
    organizationCount: Array.isArray(organizations.json) ? organizations.json.length : 0,
    project,
  };
};
