export const phonePattern = /^\d{7,15}$/;
export const bsuidPattern = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/;
export const recipientPattern = /^(?:\d{7,15}|[A-Z]{2}\.[A-Za-z0-9]{1,128})$/;

/** Aliases come only from a signed Meta webhook and the channel-scoped database mapping. */
export function allowedRecipient(recipient:string, aliases:string[], allowed:string[]) {
  return recipientPattern.test(recipient) && [recipient,...aliases].some(id=>allowed.includes(id));
}
