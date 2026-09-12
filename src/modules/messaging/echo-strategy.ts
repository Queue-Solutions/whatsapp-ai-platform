import type { ReplyStrategy } from "./types";
export const echoStrategy: ReplyStrategy = {
  async reply(context) {
    if (context.type !== "text" || !context.text) return "Please send a text message. / من فضلك ابعت رسالة نصية.";
    return `Echo: ${Array.from(context.text).slice(0, 4000).join("")}`;
  },
};
