import { Client, Connection } from "@temporalio/client";
import { getTemporalAddress } from "@summon/shared";

let client: Client | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (!client) {
    const connection = await Connection.connect({ address: getTemporalAddress() });
    client = new Client({ connection });
  }
  return client;
}
