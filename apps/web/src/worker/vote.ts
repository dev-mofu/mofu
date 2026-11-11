/**
 * $MOFU holder roadmap vote. One round at a time, defined here. Connected holder wallets vote
 * for one option and can change it while the round is open. Weight is each voter's $MOFU balance
 * when the results are counted, so tokens moved between wallets can't vote twice.
 */
export interface VoteOption {
  id: string;
  title: string;
  body: string;
}

export interface VoteRound {
  id: string;
  question: string;
  open: boolean;
  options: VoteOption[];
}

export const ROUND: VoteRound = {
  id: "round-1",
  question: "What should Mofu build next?",
  open: true,
  options: [
    {
      id: "ask-chain",
      title: "Ask the chain in chat",
      body: "Ask Mofu about any token, wallet or transaction in plain words; it calls the scanner and explainer itself.",
    },
    {
      id: "approvals",
      title: "Wallet approval checker",
      body: "See every active approval on a wallet, which ones are risky, and how to revoke them.",
    },
    {
      id: "multiplayer",
      title: "Multiplayer Mofu Town",
      body: "See other visitors walking around town as Mofu, with a holder badge and emotes.",
    },
    {
      id: "telegram",
      title: "Mofu Telegram bot",
      body: "Add Mofu to a group and type /scan or /tx to get a report right in the chat.",
    },
    {
      id: "memes",
      title: "Mofu meme maker",
      body: "Make images with the Mofu mascot: pick a face, a background and your text.",
    },
  ],
};

export interface Votes {
  cast(round: string, address: string, option: string): Promise<void>;
  mine(round: string, address: string): Promise<string | null>;
  all(round: string): Promise<Array<{ address: string; option: string }>>;
}

export const votesFromEnv = (env: Env): Votes => env.VOTES.get(env.VOTES.idFromName("roadmap"));
