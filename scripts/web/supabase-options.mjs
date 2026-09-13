import { SupabaseAdmin } from "../lib/supabase.mjs";
import { EncryptedCredentialStore } from "./encrypted-store.mjs";

export class SupabaseOptionsError extends Error {
  constructor(publicMessage, statusCode = 502, options) {
    super(publicMessage, options);
    this.name = "SupabaseOptionsError";
    this.publicMessage = publicMessage;
    this.statusCode = statusCode;
  }
}

const allowOrganization = (organization) => ({
  slug: typeof organization?.slug === "string" ? organization.slug : "",
  name: typeof organization?.name === "string" ? organization.name : "",
});

const allowProject = (project) => ({
  ref: typeof project?.ref === "string" ? project.ref : typeof project?.id === "string" ? project.id : "",
  name: typeof project?.name === "string" ? project.name : "",
  region: typeof project?.region === "string" ? project.region : "",
  status: typeof project?.status === "string" ? project.status : "UNKNOWN",
});

export const loadSupabaseOptions = async ({
  credentialStore = new EncryptedCredentialStore(),
  createAdmin = (token) => new SupabaseAdmin(token),
} = {}) => {
  let credentials;
  try {
    credentials = await credentialStore.load();
  } catch (error) {
    throw new SupabaseOptionsError(
      "Primero conectá Supabase para guardar el token de forma segura.",
      409,
      { cause: error },
    );
  }
  const admin = createAdmin(credentials.supabaseAccessToken);
  const [organizations, projects] = await Promise.all([
    admin.organizaciones(),
    admin.proyectos(),
  ]);
  if (!organizations?.ok || !projects?.ok) {
    throw new SupabaseOptionsError(
      "No pude cargar tus organizaciones y proyectos de Supabase. Revisá la conexión y volvé a intentar.",
    );
  }
  return {
    organizations: (Array.isArray(organizations.json) ? organizations.json : [])
      .map(allowOrganization)
      .filter((organization) => organization.slug),
    projects: (Array.isArray(projects.json) ? projects.json : [])
      .map(allowProject)
      .filter((project) => project.ref),
  };
};
