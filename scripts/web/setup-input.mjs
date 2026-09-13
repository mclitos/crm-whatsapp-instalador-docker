const PROJECT_REF = /^[a-z0-9]{20}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/u;
const REGION = /^[a-z]{2,3}-[a-z]+-\d$/u;

export class SetupInputError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = "SetupInputError";
    this.publicMessage = publicMessage;
    this.statusCode = 400;
  }
}

const text = (value) => typeof value === "string" ? value.trim() : "";

const privateOrLoopbackHost = (hostname) => {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
};

const validatePublicUrl = (value) => {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new SetupInputError("Ingresá una URL pública válida.");
  }
  const privateOrLoopback = privateOrLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(privateOrLoopback && url.protocol === "http:")) {
    throw new SetupInputError("La URL tiene que usar HTTPS, salvo localhost o una IP privada para pruebas en la red local.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SetupInputError("La URL pública no puede incluir credenciales, parámetros ni fragmentos.");
  }
  return url.toString().replace(/\/+$/u, "");
};

export const validateSetupInput = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SetupInputError("La solicitud no tiene un formato válido.");
  }
  const mode = text(input.mode);
  const requestId = text(input.requestId);
  if (!REQUEST_ID.test(requestId)) throw new SetupInputError("La solicitud no tiene un identificador válido.");
  const publicUrl = validatePublicUrl(input.publicUrl);

  if (mode === "existing") {
    const ref = text(input.ref);
    if (!PROJECT_REF.test(ref)) throw new SetupInputError("Elegí un proyecto válido de la lista.");
    return { mode, ref, publicUrl, requestId };
  }
  if (mode !== "create") throw new SetupInputError("Elegí si querés usar o crear un proyecto.");

  const organizationSlug = text(input.organizationSlug);
  const name = text(input.name);
  const region = text(input.region) || "sa-east-1";
  if (!IDENTIFIER.test(organizationSlug)) throw new SetupInputError("Elegí una organización válida.");
  if (name.length < 2 || name.length > 100) throw new SetupInputError("El nombre del proyecto tiene que tener entre 2 y 100 caracteres.");
  if (!REGION.test(region)) throw new SetupInputError("La región elegida no tiene un formato válido.");
  return { mode, organizationSlug, name, region, publicUrl, requestId };
};
