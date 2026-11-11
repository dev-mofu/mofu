import { DurableObject } from "cloudflare:workers";
import type { Votes } from "./vote.js";

/** All votes, one instance. Keys are vote:<round>:<address>, values the option id. */
export class VoteStore extends DurableObject<Env> implements Votes {
  async cast(round: string, address: string, option: string): Promise<void> {
    await this.ctx.storage.put(`vote:${round}:${address}`, option);
  }

  async mine(round: string, address: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`vote:${round}:${address}`)) ?? null;
  }

  async all(round: string): Promise<Array<{ address: string; option: string }>> {
    const prefix = `vote:${round}:`;
    const rows = await this.ctx.storage.list<string>({ prefix });
    return [...rows].map(([k, option]) => ({ address: k.slice(prefix.length), option }));
  }
}
