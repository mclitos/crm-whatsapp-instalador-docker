export const reportWebhookChallenge = ({
  body,
  challenge,
  responseOk,
  status,
}, { fail, ok }) => {
  if (responseOk && body === challenge) {
    ok("El webhook devuelve el desafío", "el apretón de manos funciona");
  } else if (status === 403) {
    fail(
      "El webhook devuelve 403",
      "el verify token guardado en el CRM no coincide; revisá Settings → WhatsApp",
    );
  } else {
    fail(`El webhook devolvió ${status}`, "revisá Settings → WhatsApp en el CRM");
  }
};
