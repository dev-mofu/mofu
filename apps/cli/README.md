# mofu

An AI agent in your terminal that does real work on your files: it reads, searches and edits code, runs commands, and looks things up. It always asks before it changes a file or runs a command.

Mofu uses [OpenRouter](https://openrouter.ai), so you can pick almost any model. You bring your own API key.

## Requirements

- Node.js 22 or newer
- An OpenRouter API key: <https://openrouter.ai/keys>

## Set up your key

Either save it once:

```sh
mofu auth
```

or set it for the current shell (this takes priority over the saved key):

```sh
# macOS / Linux
export OPENROUTER_API_KEY=sk-or-...

# Windows PowerShell
$env:OPENROUTER_API_KEY = "sk-or-..."
```

`mofu auth` stores the key in `~/.mofu/config.json`. On macOS and Linux the file is readable only by you (mode 600). On Windows it lives in your user profile folder, which other standard users can't read.

## Use it

```sh
mofu                          # interactive chat in the current folder
mofu "what does this repo do?"  # one question, then exit
mofu -m qwen/qwen3.7-flash    # pick a model for this run
```

In chat:

| Command       | What it does                              |
| ------------- | ----------------------------------------- |
| `/help`       | List commands                             |
| `/model [id]` | Show or switch the model for this session |
| `/clear`      | Start a fresh conversation                |
| `/memory`     | Show what Mofu remembers about you        |
| `/forget`     | Clear that memory                         |
| `/exit`       | Quit                                      |

Ctrl+C stops a reply that's running. At the prompt, it quits.

## What Mofu can do

| Tool                                                   | Needs your approval |
| ------------------------------------------------------ | ------------------- |
| List, read and search files                            | No                  |
| Create, overwrite or edit files (you see a diff first) | Yes                 |
| Run a command (PowerShell on Windows, `sh` elsewhere)  | Yes                 |
| Look up Wikipedia summaries and dictionary definitions | No                  |
| Remember a fact you ask it to (`~/.mofu/memory.md`)    | Yes                 |

File and command tools only work inside the folder you started Mofu in. Paths that escape it (`..`, absolute paths elsewhere, symlinks pointing outside) are refused.

## Choosing a model

The model comes from, in order: `--model`, the `MOFU_MODEL` environment variable, `"model"` in `~/.mofu/config.json`, then the default (`anthropic/claude-haiku-5.5`, chosen because it's cheap and reliable with tools). The model must support tool calling. Browse models and prices at <https://openrouter.ai/models>.

Each reply ends with a token count so you can keep an eye on cost.
