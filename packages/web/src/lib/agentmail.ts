import { AgentMailClient } from "agentmail";

const agentmail = new AgentMailClient({
  apiKey: process.env.AGENTMAIL_API_KEY!,
});

export async function createAgentInbox(
  username: string,
  displayName: string,
): Promise<string> {
  const inbox = await agentmail.inboxes.create({
    username,
    displayName,
  });
  return inbox.email;
}
