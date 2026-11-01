// The exact words a household agrees to. The text they were shown is stored
// with their consent record, so changing these words later never rewrites
// history. Have a lawyer review this wording before using it with real people.

export const CONSENT_VERSION = '2026-10-v1';

export const CONSENT_SCOPE = 'Contact the utility and assistance programs on my behalf, after staff review';

export const CONSENT_TEXT = {
  en: 'I agree that Bill Shock Desk may share the details from my notice with my utility and with assistance programs, to ask for help for me. Nothing is sent until a staff member has reviewed it. I can take this back at any time by contacting staff.',
  es: 'Acepto que Bill Shock Desk comparta los datos de mi aviso con mi compañía de servicios y con programas de ayuda, para pedir ayuda por mí. No se envía nada hasta que una persona del equipo lo revise. Puedo retirar este permiso en cualquier momento comunicándome con el personal.',
};

export const SMS_TEXT = {
  en: 'Text me reminders before my shutoff date. Message and data rates may apply. Reply STOP at any time.',
  es: 'Envíenme recordatorios por texto antes de mi fecha de corte. Pueden aplicarse tarifas de mensajes y datos. Responda STOP cuando quiera.',
};
